#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "net_structrw.h"

static void check_player_count(unsigned int count)
{
    unsigned char data[20 + 255] = {0};
    struct {
        net_gamesettings_t settings;
        unsigned int guard[255];
    } parsed;
    net_packet_t packet = {
        .data = data,
        .len = 20 + count,
        .alloced = sizeof(data),
        .pos = 0,
    };

    memset(&parsed, 0xa5, sizeof(parsed));
    data[18] = count;
    memset(data + 20, 3, count);
    assert(NET_ReadSettings(&packet, &parsed.settings));
    assert(parsed.settings.num_players == count);
    for (unsigned int i = 0; i < count && i < NET_MAXPLAYERS; ++i) {
        assert(parsed.settings.player_classes[i] == 3);
    }
    for (unsigned int i = 0; i < 255; ++i) {
        assert(parsed.guard[i] == 0xa5a5a5a5);
    }

    if (count > 0 && count <= NET_MAXPLAYERS) {
        packet.pos = 0;
        --packet.len;
        assert(!NET_ReadSettings(&packet, &parsed.settings));
    }
}

int main(void)
{
    check_player_count(0);
    check_player_count(1);
    check_player_count(NET_MAXPLAYERS);
    check_player_count(NET_MAXPLAYERS + 1);
    check_player_count(255);
    puts("Doom settings bounds checks passed");
    return 0;
}
