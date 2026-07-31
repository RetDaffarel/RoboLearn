import network
import socket
import time

# === 1. KONEKSI WIFI (Ganti dengan Wifi Anda) ===
SSID = "B."
PASSWORD = "1sampe10"

wlan = network.WLAN(network.STA_IF)
wlan.active(False)
time.sleep(0.5)
wlan.active(True)
wlan.connect(SSID, PASSWORD)

print("Menghubungkan ke WiFi...", end="")
while not wlan.isconnected():
    print(".", end="")
    time.sleep(0.5)

ip_address = wlan.ifconfig()[0]
print("\n=== KONEKSI BERHASIL ===")
print("Ketik IP ini di browser:", ip_address)

# === 2. MEMBUAT WEB SERVER (PORT 80) ===
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.bind(('', 80)) # Menggunakan Port standar 80
s.listen(5)

print("Web Server AKTIF & menunggu koneksi...\n")

# Tampilan halaman web sederhana
html_page = """<!DOCTYPE html>
<html>
<head><title>ESP32 Web Server</title></head>
<body>
    <h1 style="color: #0066cc;">Halo dari ESP32!</h1>
    <p>Jika Anda melihat tulisan ini, Web Server Anda 100% BERHASIL.</p>
</body>
</html>"""

# Loop ini harus jalan terus agar server tidak mati
while True:
    try:
        conn, addr = s.accept()
        print(f"Ada yang mengakses dari perangkat: {addr}")
        request = conn.recv(1024)
        
        # Mengirimkan respon standar HTTP ke browser
        conn.send('HTTP/1.1 200 OK\n')
        conn.send('Content-Type: text/html\n')
        conn.send('Connection: close\n\n')
        conn.sendall(html_page)
        conn.close()
    except Exception as e:
        print("Terjadi error pada server:", e)