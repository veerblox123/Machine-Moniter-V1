# Machine Monitor

A local, Cockpit-inspired dashboard for monitoring and managing a Linux machine from your browser. It collects system information on the machine running the Node.js server and serves the dashboard at `http://localhost:3000`.

Machine Monitor is also packaged as a Linux desktop app. Download the `.AppImage` for a portable app, or install the `.deb` on Debian-based systems, from the [GitHub Releases page](https://github.com/veerblox123/Machine-Moniter-V1/releases).

## Features

- Live overview of CPU load, memory, root filesystem usage, temperature when exposed by the system, uptime, network addresses, and top processes.
- System pages for processes, systemd services, journal logs, storage devices, network interfaces, package updates, installed packages, user accounts, firewall status, containers, and virtual machines.
- Browser terminal, SSH connection form, and optional tmate/sshx session sharing when those command-line tools are installed and their relay services are reachable.
- Service start, stop, and restart actions. Actions run with the app user's permissions; administrator-only actions may be unavailable unless non-interactive `sudo` is configured.
- Automatic dashboard refresh and a dark, responsive interface.
- Local sign-in checked against the current Linux account's `sudo` password verifier; session tokens expire after eight hours and passwords are not stored.

Some information depends on host tools and permissions. A missing service manager, container engine, hypervisor, thermal sensor, or restricted system database is shown as unavailable rather than inferred. Package update checks use a simulated `apt-get upgrade`; they do not install updates.

## Requirements

- Linux (the system detail and management integrations use Linux tools)
- Node.js 18 or newer
- No npm packages are required
- Desktop app development/building requires npm packages listed in `package.json`.
- For password sign-in: Linux, a non-root user, and `sudo` configured to authenticate that user with their laptop password.

Optional integrations are read-only where possible and only appear as available when the related host tools are installed:

| Feature | Host tools |
| --- | --- |
| Services and logs | `systemctl`, `journalctl` |
| Storage and network | `lsblk`, `ip` |
| Accounts and packages | `getent`, `dpkg-query` |
| Package update check | `apt-get` |
| Containers | Docker or Podman |
| Virtual machines | `virsh` / libvirt |
| Firewall | UFW or firewalld |
| SSH / shared sessions | OpenSSH, optionally `tmate` and `sshx` |

## Run locally

```sh
node server.js
```

Then open [http://localhost:3000](http://localhost:3000). You can also use `npm start`. To select another port:

```sh
PORT=3001 node server.js
```

## Desktop app development

```sh
npm install
npm run desktop
```

To build Linux packages locally:

```sh
npm run dist:linux
```

To publish a new GitHub release, push a version tag such as `v1.0.1`. The Linux release workflow builds an AppImage and a Debian package, then attaches them to that release. Releases are currently Linux-only; Windows and macOS are not packaged.

Keep the server bound to localhost when using the browser terminal. The terminal runs shell commands as the same operating-system user that launched the server. Do not expose this app to an untrusted network: the browser terminal provides command execution on the host. Shared terminal tools can grant remote access to anyone holding their session link, so only share those links with trusted people. The sign-in check uses `sudo`'s password verifier, so sign-in is unavailable when the app runs as root or on systems without `sudo`.

## Privacy

Metrics are collected by the local server and served to the browser. The app does not include an account system or a remote telemetry service. The page loads its typography from Google Fonts when internet access is available; system monitoring continues to work without those fonts.

## Troubleshooting

- **Port 3000 is already in use:** stop the existing `node server.js` process, or run with another `PORT`.
- **A page says its data is unavailable:** check that its optional host tool is installed and that your user has permission to read that system information.
- **Service actions are denied:** system-level service operations usually require administrator privileges. The app intentionally does not prompt for or store a sudo password.
- **tmate/sshx does not connect:** install the relevant tool and check that the machine can resolve and reach its configured relay service. A local DNS lookup failure cannot be fixed by the dashboard.

## License

No license has been selected yet. Add a license before redistributing or accepting contributions.
