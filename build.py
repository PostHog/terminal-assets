import io
import sys
import gzip
import json
import base64
import shutil
import hashlib
import tarfile
import argparse
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
NODE_VERSION = "22.23.2"
PI_VERSION = "0.87.1"
ALPINE = "https://dl-cdn.alpinelinux.org/alpine/v3.22/main/x86"


def download(url: str, integrity: str) -> bytes:
    algorithm, expected = integrity.split("-", 1)
    data = urllib.request.urlopen(url, timeout=120).read()
    digest = hashlib.new(algorithm, data).digest()
    actual = digest.hex() if algorithm == "sha256" else base64.b64encode(digest).decode()
    if actual != expected:
        raise ValueError(f"Checksum mismatch: {url}")
    return data


def extract_npm(data: bytes, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        for member in archive:
            if not member.name.startswith("package/"):
                raise ValueError(f"Unexpected npm archive path: {member.name} in {destination}")
            member.name = member.name.removeprefix("package/")
            if member.name:
                archive.extract(member, destination, filter="data")


def pack(root: Path, name: str) -> dict[str, str | int]:
    for notice in json.loads((ROOT / "recipes/licenses.json").read_text()):
        data = (ROOT / "licenses" / notice["file"]).read_bytes()
        if hashlib.sha256(data).hexdigest() != notice["sha256"]:
            raise ValueError(f"Changed license notice: {notice['file']}")
    shutil.copytree(ROOT / "licenses", root / "licenses", dirs_exist_ok=True)
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for path in sorted(root.rglob("*")):
            info = archive.gettarinfo(str(path), arcname=str(path.relative_to(root)))
            info.uid = info.gid = info.mtime = 0
            info.uname = info.gname = ""
            info.mode = 0o755 if info.isdir() or info.issym() or info.mode & 0o111 else 0o644
            if info.isfile():
                with path.open("rb") as source:
                    archive.addfile(info, source)
            else:
                archive.addfile(info)
    data = gzip.compress(buffer.getvalue(), mtime=0)
    (ROOT / "archives" / name).write_bytes(data)
    return {
        "file": f"archives/{name}",
        "sha256": hashlib.sha256(data).hexdigest(),
        "size": len(data),
        "archiveSize": buffer.tell(),
    }


def build_node(root: Path) -> dict[str, object]:
    packages = json.loads((ROOT / "recipes/node-packages.json").read_text())
    for package in packages:
        data = download(f"{ALPINE}/{package['file']}", f"sha256-{package['sha256']}")
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz", ignore_zeros=True) as archive:
            archive.extractall(
                root, members=[m for m in archive if m.name.startswith(("lib/", "usr/", "etc/"))], filter="data"
            )
    (root / "bin").mkdir()
    prefix = f"/opt/posthog-packages/node-{NODE_VERSION}"
    launcher = root / "bin/node"
    launcher.write_text(
        "#!/bin/sh\n"
        + f"export LD_LIBRARY_PATH={prefix}/lib:{prefix}/usr/lib\nexport ICU_DATA={prefix}/usr/share/icu/76.1\n"
        + f'exec {prefix}/usr/bin/node "$@"\n'
    )
    launcher.chmod(0o755)
    return {
        "name": "Node.js",
        "version": NODE_VERSION,
        **pack(root, f"node-{NODE_VERSION}-linux-i386.tar.gz"),
        "dependencies": [],
        "commands": {"node": f"{prefix}/bin/node", "nodejs": f"{prefix}/bin/node"},
    }


def build_pi(root: Path) -> dict[str, object]:
    release = json.loads((ROOT / "recipes/pi-release.json").read_text())
    extract_npm(download(release["url"], release["integrity"]), root)
    lock = json.loads((ROOT / "recipes/pi-lock.json").read_text())
    for path, package in lock["packages"].items():
        if not path or package.get("dev") or "node_modules/@types/" in path:
            continue
        if ("os" in package and "linux" not in package["os"]) or ("cpu" in package and "ia32" not in package["cpu"]):
            continue
        if ".." in Path(path).parts or not path.startswith("node_modules/"):
            raise ValueError(f"Invalid dependency path: {path}")
        extract_npm(download(package["resolved"], package["integrity"]), root / path)
    for path in root.rglob("*"):
        if path.is_file() and (path.name.endswith((".map", ".d.ts", ".d.cts", ".d.mts"))):
            path.unlink()
    (root / "npm-shrinkwrap.json").write_text(json.dumps(lock, indent=2) + "\n")
    for package in json.loads((ROOT / "recipes/pi-tools.json").read_text()):
        data = download(package["url"], f"sha256-{package['sha256']}")
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz", ignore_zeros=True) as archive:
            archive.extractall(root, members=[m for m in archive if m.name.startswith(("lib/", "usr/"))], filter="data")
    prefix = f"/opt/posthog-packages/pi-{PI_VERSION}"
    node = f"/opt/posthog-packages/node-{NODE_VERSION}"
    (root / "bin").mkdir(exist_ok=True)
    for command in ("fd", "rg"):
        launcher = root / "bin" / command
        launcher.write_text(
            "#!/bin/sh\n"
            + f"exec {node}/lib/ld-musl-i386.so.1 --library-path {prefix}/usr/lib:{node}/lib:{node}/usr/lib "
            + f'{prefix}/usr/bin/{command} "$@"\n'
        )
        launcher.chmod(0o755)
    launcher = root / "bin/pi"
    shutil.copyfile(ROOT / "pi-provider.mjs", root / "pi-provider.mjs")
    launcher.write_text(
        "#!/bin/sh\n"
        + f'export PI_OFFLINE=1 PATH="{prefix}/bin:$PATH"\n'
        + f'exec node {prefix}/dist/bundle/cli.js --extension {prefix}/pi-provider.mjs '
        + '--provider posthog --model claude-sonnet-4-6 "$@"\n'
    )
    launcher.chmod(0o755)
    return {
        "name": "pi",
        "version": PI_VERSION,
        **pack(root, f"pi-{PI_VERSION}.tar.gz"),
        "dependencies": ["node"],
        "commands": {"pi": f"{prefix}/bin/pi"},
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", choices=["node", "pi"])
    args = parser.parse_args()
    manifest = {"packages": {}}
    if (ROOT / "manifest.json").exists():
        manifest = json.loads((ROOT / "manifest.json").read_text())
    for name, build in [("node", build_node), ("pi", build_pi)]:
        if args.only and args.only != name:
            continue
        with tempfile.TemporaryDirectory() as temporary:
            manifest["packages"][name] = build(Path(temporary))
            sys.stdout.write(json.dumps(manifest["packages"][name], indent=2) + "\n")
    (ROOT / "manifest.json").write_text(json.dumps(manifest, indent=4) + "\n")


if __name__ == "__main__":
    main()
