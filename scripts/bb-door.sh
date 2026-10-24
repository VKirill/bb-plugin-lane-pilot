#!/usr/bin/env bash
# The BB door on this household only (SMA map: Door on this machine only): port 38886 answers loopback, WireGuard peers and the docker
# bridges (Caddy for bb.vechkasov.pro); everything else is dropped. Idempotent: the rules are removed and added again.
set -euo pipefail
PORT="${1:-38886}"
for rule in "-i lo" "-i wg0" "-s 172.16.0.0/12"; do
  iptables -D INPUT -p tcp --dport "$PORT" $rule -j ACCEPT 2>/dev/null || true
done
iptables -D INPUT -p tcp --dport "$PORT" -j DROP 2>/dev/null || true
iptables -I INPUT 1 -p tcp --dport "$PORT" -i lo -j ACCEPT
iptables -I INPUT 2 -p tcp --dport "$PORT" -i wg0 -j ACCEPT
iptables -I INPUT 3 -p tcp --dport "$PORT" -s 172.16.0.0/12 -j ACCEPT
iptables -I INPUT 4 -p tcp --dport "$PORT" -j DROP
iptables -S INPUT | grep -- "--dport $PORT"
