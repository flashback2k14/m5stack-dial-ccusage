Hier den SSH-Key ablegen. Erzeugen mit:

  ssh-keygen -t ed25519 -f ./id_dial -N "" -C "dial-usage-proxy"

Danach den Public Key auf dem Mac autorisieren:

  ssh-copy-id -i ./id_dial.pub <user>@<mac-ip>

Die Keys selbst NIEMALS ins Git-Repo committen (siehe .gitignore).
