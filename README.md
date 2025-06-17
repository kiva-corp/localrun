# localrun

> **⚠️ Warning: This is currently in experimental state**

This project is based on [localtunnel](https://github.com/localtunnel/localtunnel) and has been adapted to work with Cloudflare Workers and WebSocket proxy servers.

localrun exposes your localhost to the world for easy testing and sharing! No need to mess with DNS or deploy just to have others test out your changes.

Great for working with browser testing tools, webhook testing, or external API callback services that require a public URL for callbacks.

## Quickstart

```bash
npx localrun --port 8000
```

## Installation

### Globally

```bash
npm install -g localrun
```

### As a dependency in your project

```bash
npm install localrun
# or
yarn add localrun
```

## CLI Usage

When localrun is installed globally, use the `lr` command to start the tunnel.

```bash
lr --port 8000
```

That's it! It will connect to the tunnel server, setup the tunnel, and tell you what URL to use for your testing. This URL will remain active for the duration of your session; so feel free to share it with others!

You can restart your local server all you want, `lr` is smart enough to detect this and reconnect once it is back.

### Arguments

Below are some common arguments. See `lr --help` for all available options:

- `--port` or `-p` (required) - Internal HTTP server port
- `--subdomain` or `-s` - Request a named subdomain (alphanumeric, exactly 10 characters)
- `--host` or `-h` - Upstream server providing forwarding (default: https://localrun.stream)
- `--local-host` or `-l` - Tunnel traffic to this host instead of localhost
- `--local-https` - Tunnel traffic to a local HTTPS server
- `--local-cert` - Path to certificate PEM file for local HTTPS server
- `--local-key` - Path to certificate key file for local HTTPS server
- `--local-ca` - Path to certificate authority file for self-signed certificates
- `--allow-invalid-cert` - Disable certificate checks for your local HTTPS server
- `--timeout` - Request timeout in milliseconds (default: 15000)
- `--max-retries` - Maximum number of retry attempts for failed requests (default: 2)
- `--open` or `-o` - Opens the tunnel URL in your browser
- `--print-requests` - Print basic request info

You may also specify arguments via environment variables:

```bash
PORT=3000 lr
DEBUG=localrun:* lr --port 3000  # Enable debug logging
```

### Examples

```bash
# Basic usage
lr --port 3000

# Request specific subdomain
lr --port 8080 --subdomain myapp12345

# Tunnel to HTTPS local server
lr --port 443 --local-https --local-cert ./cert.pem --local-key ./key.pem

# Tunnel to different local host
lr --port 8000 --local-host 192.168.1.100

# Open in browser automatically
lr --port 3000 --open

# Print request logs
lr --port 8000 --print-requests
```

## API

The localrun client is also usable through an API for test integration, automation, etc.

### localrun(port [,options])

Creates a new localrun tunnel to the specified local `port`. Returns a Promise that resolves once you have been assigned a public tunnel URL.

```javascript
const localrun = require("localrun");

(async () => {
  const tunnel = await localrun({ port: 3000 });

  // The assigned public URL for your tunnel
  // i.e. https://abcdefghij.localrun.stream
  console.log("Tunnel URL:", tunnel.url);

  tunnel.on("close", () => {
    // Tunnel is closed
  });
})();
```

### Alternative API usage

```javascript
// Using port as first argument
const tunnel = await localrun(3000, {
  subdomain: "myapp12345",
});

// Legacy callback style (for backwards compatibility)
localrun.connect(3000, (err, tunnel) => {
  if (err) throw err;
  console.log("Tunnel URL:", tunnel.url);
});
```

### Options

- `port` (number) [required] - The local port number to expose through localrun
- `subdomain` (string) - Request a specific subdomain (alphanumeric, exactly 10 characters)
- `host` (string) - URL for the upstream proxy server (default: https://localrun.stream)
- `localHost` (string) - Proxy to this hostname instead of localhost
- `localHttps` (boolean) - Enable tunneling to local HTTPS server
- `localCert` (string) - Path to certificate PEM file for local HTTPS server
- `localKey` (string) - Path to certificate key file for local HTTPS server
- `localCa` (string) - Path to certificate authority file for self-signed certificates
- `allowInvalidCert` (boolean) - Disable certificate checks for your local HTTPS server
- `timeout` (number) - Request timeout in milliseconds (default: 15000)
- `maxRetries` (number) - Maximum number of retry attempts (default: 2)

### Tunnel Instance

The `tunnel` instance returned emits the following events:

| Event                    | Args | Description                                                        |
| ------------------------ | ---- | ------------------------------------------------------------------ |
| `url`                    | url  | Fires when the tunnel URL is assigned                              |
| `request`                | info | Fires when a request is processed (contains method, path, headers) |
| `error`                  | err  | Fires when an error occurs                                         |
| `close`                  |      | Fires when the tunnel is closed                                    |
| `circuit-breaker-open`   | info | Fires when circuit breaker opens due to consecutive errors         |
| `circuit-breaker-closed` |      | Fires when circuit breaker resets                                  |

The `tunnel` instance has the following methods:

| Method               | Description                                  |
| -------------------- | -------------------------------------------- |
| `close()`            | Close the tunnel                             |
| `gracefulShutdown()` | Gracefully close the tunnel with cleanup     |
| `getStats()`         | Get tunnel statistics and health information |

### Properties

| Property           | Description                      |
| ------------------ | -------------------------------- |
| `tunnel.url`       | The public tunnel URL            |
| `tunnel.cachedUrl` | Cached version of the tunnel URL |
| `tunnel.clientId`  | Unique client identifier         |

## Advanced Features

### Circuit Breaker

The client includes a circuit breaker that automatically stops forwarding requests when the local server becomes unresponsive, preventing resource waste and providing better error handling.

### Server-Sent Events (SSE) Support

Full support for streaming responses and SSE connections with proper connection management.

### Message Chunking

Large messages are automatically chunked for reliable transmission through WebSocket connections.

### Automatic Reconnection

The client automatically reconnects with exponential backoff when connections are lost.

### Debug Logging

Enable detailed logging for troubleshooting:

```bash
DEBUG=localrun:* lr --port 3000
```

## Troubleshooting

### Common Issues

1. **Connection Refused**: Make sure your local server is running on the specified port
2. **Subdomain Unavailable**: Try a different 10-character subdomain
3. **TLS/SSL Errors**: Check your certificate and key file paths, and ensure they are valid
4. **Timeouts**: Increase the timeout value if you have a slow server startup
5. **Port Already in Use**: Ensure the port is not being used by another application

### Debugging Tips

- Use `--print-requests` to see incoming request logs
- Check the localrun client logs for any error messages
- Enable debug logging with `DEBUG=localrun:*` for more detailed output

## License

MIT License. See `LICENSE` for details.
