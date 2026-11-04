Synthetic self-signed certificate and public test private key for the local
SOCKS/TLS regression fixture only. This key protects no real service or data.
The fixture terminates TLS locally and never forwards to the requested public
address. A child process adds this certificate to its own trust store for
positive/hostname-mismatch cases; certificate validation remains enabled.
