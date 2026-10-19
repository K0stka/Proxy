"""Root-only isolated kernel handoff integration check; never changes production rules."""
import pathlib
import shutil
import socket
import subprocess
import tempfile
import time


def main():
    name = 'proxy-handoff-test'
    work = pathlib.Path(tempfile.mkdtemp(prefix='proxy-handoff-test-'))
    def run(args, **kwargs):
        return subprocess.run(args, check=True, **kwargs)
    server = work / 'server.py'
    server.write_text('''import socket,threading,time
for ip,marker in [('10.250.241.2',b'old:'),('10.250.242.3',b'new:')]:
 def tcp(ip=ip,marker=marker):
  s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind((ip,31001));s.listen()
  def echo(c,a):
   with c:
    while data:=c.recv(1024): c.sendall(marker+a[0].encode()+b':'+data)
  while True:
   c,a=s.accept();threading.Thread(target=echo,args=(c,a),daemon=True).start()
 def udp(ip=ip,marker=marker):
  s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.bind((ip,31001))
  while True:
   data,a=s.recvfrom(1024);s.sendto(marker+a[0].encode()+b':'+data,a)
 threading.Thread(target=tcp,daemon=True).start();threading.Thread(target=udp,daemon=True).start()
while True:time.sleep(1)
''')
    proc = None
    created = False
    try:
        run(['modprobe', 'ip_vs_rr'])
        run(['ip', 'netns', 'add', name])
        created = True
        run(['ip', 'link', 'add', 'pht-host', 'type', 'veth', 'peer', 'name', 'pht-test'])
        run(['ip', 'link', 'set', 'pht-test', 'netns', name])
        run(['ip', 'addr', 'add', '10.250.241.1/30', 'dev', 'pht-host'])
        run(['ip', 'link', 'set', 'pht-host', 'up'])
        run(['ip', 'route', 'add', '10.250.242.0/24', 'via', '10.250.241.2', 'dev', 'pht-host'])
        ns = ['ip', 'netns', 'exec', name]
        run(ns + ['sysctl', '-q', '-w', 'net.ipv4.vs.expire_nodest_conn=1'])
        for args in [['ip', 'link', 'set', 'lo', 'up'], ['ip', 'addr', 'add', '10.250.241.2/30', 'dev', 'pht-test'], ['ip', 'link', 'set', 'pht-test', 'up'], ['ip', 'addr', 'add', '10.250.242.2/32', 'dev', 'lo'], ['ip', 'addr', 'add', '10.250.242.3/32', 'dev', 'lo']]:
            run(ns + args)
        rules = '''table inet test_guard {
 chain input {
  type filter hook input priority 0; policy accept;
  iifname "pht-test" ip daddr 10.250.242.0/24 drop
  iifname "pht-test" tcp dport 31002 drop
 }
}
'''
        run(ns + ['nft', '-f', '-'], input=rules, text=True)
        proc = subprocess.Popen(ns + ['python3', str(server)])
        time.sleep(1)
        tcp = socket.create_connection(('10.250.241.2', 31001), timeout=2)
        udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        udp.settimeout(2)
        def check(sock, expected, datagram=False):
            if datagram:
                sock.sendto(b'test', ('10.250.241.2', 31001))
                result = sock.recv(1024)
            else:
                sock.sendall(b'test')
                result = sock.recv(1024)
            assert result == expected + b'10.250.241.1:test', result
        check(tcp, b'old:')
        check(udp, b'old:', True)
        for proto in ['-t', '-u']:
            run(ns + ['ipvsadm', '-A', proto, '10.250.241.2:31001', '-s', 'rr'])
            run(ns + ['ipvsadm', '-a', proto, '10.250.241.2:31001', '-r', '10.250.241.2:31001', '-m', '-w', '1'])
        check(tcp, b'old:')
        check(udp, b'old:', True)
        for proto in ['-t', '-u']:
            run(ns + ['ipvsadm', '-a', proto, '10.250.241.2:31001', '-r', '10.250.242.3:31001', '-m', '-w', '1'])
            run(ns + ['ipvsadm', '-e', proto, '10.250.241.2:31001', '-r', '10.250.241.2:31001', '-m', '-w', '0'])
        check(tcp, b'old:')
        check(udp, b'old:', True)
        with socket.create_connection(('10.250.241.2', 31001), timeout=2) as fresh:
            check(fresh, b'new:')
        newudp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        newudp.settimeout(2)
        check(newudp, b'new:', True)
        print('PASS: TCP/UDP handoff retains old sessions, moves new sessions, preserves client IP.', flush=True)
        run(ns + ['ipvsadm', '-A', '-t', '10.250.241.2:31002', '-s', 'rr'])
        run(ns + ['ipvsadm', '-a', '-t', '10.250.241.2:31002', '-r', '10.250.242.3:31001', '-m'])
        for ip, port in [('10.250.241.2', 31002), ('10.250.242.3', 31001)]:
            try:
                socket.create_connection((ip, port), timeout=.3)
            except OSError:
                pass
            else:
                raise AssertionError('Firewall bypass')
        print('PASS: public deny and direct-generation isolation remain effective with live IPVS destinations.', flush=True)
        run(ns + ['ipvsadm', '-A', '-t', '127.0.0.1:31001', '-s', 'rr'])
        run(ns + ['ipvsadm', '-a', '-t', '127.0.0.1:31001', '-r', '10.250.242.3:31001', '-m'])
        run(ns + ['python3', '-c', "import socket; s=socket.create_connection(('127.0.0.1',31001),timeout=2); s.sendall(b'local'); assert s.recv(1024)==b'new:127.0.0.1:local'"])
        print('PASS: private loopback management handoff.', flush=True)
        run(ns + ['ipvsadm', '-d', '-u', '10.250.241.2:31001', '-r', '10.250.241.2:31001'])
        udp.settimeout(.5)
        for attempt in range(3):
            try:
                check(udp, b'new:', True)
                break
            except socket.timeout:
                if attempt == 2:
                    raise
        print('PASS: forced UDP retirement permits reconnection on the same client socket.', flush=True)
    finally:
        if proc:
            proc.terminate()
            proc.wait(timeout=3)
        if created:
            subprocess.run(['ip', 'netns', 'del', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run(['ip', 'link', 'del', 'pht-host'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shutil.rmtree(work)


if __name__ == '__main__':
    main()
