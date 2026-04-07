<h1 align="center">cloakmail-cli</h1>

<p align="center">
  The official CLI for deploying <a href="https://github.com/DreamsHive/cloakmail">CloakMail</a> to Cloudflare.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/cloakmail-cli"><img src="https://img.shields.io/npm/v/cloakmail-cli" alt="npm" /></a>
  <a href="https://github.com/DreamsHive/cloakmail-cli/blob/main/LICENSE"><img src="https://img.shields.io/github/license/DreamsHive/cloakmail-cli" alt="License" /></a>
</p>

---

## Usage

Zero-install — run directly with `bunx` from any directory on your machine:

```bash
bunx cloakmail-cli setup
```

Or install it globally:

```bash
bun install -g cloakmail-cli
cloakmail-cli setup
```

### Commands

```bash
cloakmail-cli setup     # Deploy CloakMail to your Cloudflare account end-to-end
cloakmail-cli destroy   # Tear down a previous deployment
cloakmail-cli --help    # Show all available flags and options
```

`setup` walks you through the entire deployment: Cloudflare API token, email zone, web hostname, then provisions D1 and R2, deploys both Workers, configures Email Routing, binds your custom domain, and verifies the whole thing.

`destroy` cleans up every resource the wizard created — workers, D1 database, R2 bucket, catch-all rule, custom domain — with a confirmation prompt.

## Documentation

For full setup guides, API reference, and deployment instructions, visit the official documentation at [docs.cloakmail.dev](https://docs.cloakmail.dev).

## License

This project is licensed under the [MIT License](LICENSE).
