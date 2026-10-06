# 1. Regenerate a new unique machine ID
sudo systemd-machine-id-setup

# 2. Re-link the dbus machine-id
sudo dbus-uuidgen --ensure

# 3. Restart systemd-resolved (the DNS resolver)
systemctl restart systemd-networkd

# 4. Verify systemd-resolved is running fine
sudo systemctl status systemd-resolved

# Force Google DNS temporarily to get internet access
echo -e "nameserver 8.8.8.8\nnameserver 1.1.1.1" | sudo tee /etc/resolv.conf

systemctl restart systemd-networkd

getent hosts google.com
dig google.com
nslookup google.com