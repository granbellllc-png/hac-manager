# Local TLS test identity

This self-signed certificate and private key are public, disposable test fixtures.
They identify only the loopback TLS server in the test suite and must never be used
for deployment. The suite does not install this certificate in a system trust store.
