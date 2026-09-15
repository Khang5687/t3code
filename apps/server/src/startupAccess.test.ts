import { assert, expect, it } from "@effect/vitest";

import { resolveListenAddress } from "./listenAddress.ts";
import {
  buildPairingUrl,
  formatHeadlessServeOutput,
  renderTerminalQrCode,
  resolveHeadlessConnectionString,
  resolveListeningPort,
} from "./startupAccess.ts";

it("prefers localhost when no explicit host is configured", () => {
  expect(resolveHeadlessConnectionString(resolveListenAddress(undefined, {}), 3773)).toBe(
    "http://localhost:3773",
  );
});

it("keeps explicit bind hosts in the connection string", () => {
  expect(resolveHeadlessConnectionString(resolveListenAddress("127.0.0.1", {}), 3773)).toBe(
    "http://127.0.0.1:3773",
  );
  expect(resolveHeadlessConnectionString(resolveListenAddress("::1", {}), 3773)).toBe(
    "http://[::1]:3773",
  );
});

it("resolves wildcard hosts to a concrete external interface when one is available", () => {
  const listen = resolveListenAddress("0.0.0.0", {
    en0: [
      {
        address: "192.168.1.42",
        netmask: "255.255.255.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: "192.168.1.42/24",
      },
    ],
    lo0: [
      {
        address: "127.0.0.1",
        netmask: "255.0.0.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: true,
        cidr: "127.0.0.1/8",
      },
    ],
  });

  expect(resolveHeadlessConnectionString(listen, 3773)).toBe("http://192.168.1.42:3773");
});

it("prefers the actual bound port when an http server address is available", () => {
  expect(resolveListeningPort({ port: 4123 }, 3773)).toBe(4123);
  expect(resolveListeningPort("pipe", 3773)).toBe(3773);
  expect(resolveListeningPort(null, 3773)).toBe(3773);
});

it("builds a pairing URL that embeds the token in the hash", () => {
  expect(buildPairingUrl("http://192.168.1.42:3773", "PAIRCODE")).toBe(
    "http://192.168.1.42:3773/pair#token=PAIRCODE",
  );
});

it("renders terminal QR codes as a multi-line unicode block grid", () => {
  const qrCode = renderTerminalQrCode("http://192.168.1.42:3773/pair#token=PAIRCODE");

  assert.isTrue(qrCode.includes("█"));
  assert.isTrue(qrCode.split("\n").length > 10);
});

it("formats headless serve output with the connection string, token, pairing url, and qr code", () => {
  const output = formatHeadlessServeOutput({
    connectionString: "http://192.168.1.42:3773",
    token: "PAIRCODE",
    pairingUrl: "http://192.168.1.42:3773/pair#token=PAIRCODE",
    warnings: [],
  });

  expect(output).toContain("Connection string: http://192.168.1.42:3773");
  expect(output).toContain("Token: PAIRCODE");
  expect(output).toContain("Pairing URL: http://192.168.1.42:3773/pair#token=PAIRCODE");
  assert.isTrue(output.includes("█") || output.includes("▀") || output.includes("▄"));
});

it("prints resolver warnings above the ready line so a loopback fallback is visible", () => {
  const output = formatHeadlessServeOutput({
    connectionString: "http://127.0.0.1:3773",
    token: "PAIRCODE",
    pairingUrl: "http://127.0.0.1:3773/pair#token=PAIRCODE",
    warnings: ["tailnet selected but no Tailscale address was found", "listening on loopback only"],
  });

  expect(output).toContain("Warning: tailnet selected but no Tailscale address was found");
  expect(output).toContain("Warning: listening on loopback only");
  expect(output.indexOf("Warning:")).toBeLessThan(output.indexOf("T3 Code server is ready."));
});

it("uses the resolved bind address for the connection string of a tailnet selection", () => {
  const listen = resolveListenAddress("tailnet", {
    lo0: [
      {
        address: "127.0.0.1",
        netmask: "255.0.0.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: true,
        cidr: "127.0.0.1/8",
      },
    ],
    utun3: [
      {
        address: "100.101.102.103",
        netmask: "255.255.255.255",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: "100.101.102.103/32",
      },
    ],
  });

  expect(resolveHeadlessConnectionString(listen, 3773)).toBe("http://100.101.102.103:3773");
  expect(buildPairingUrl(resolveHeadlessConnectionString(listen, 3773), "PAIRCODE")).toBe(
    "http://100.101.102.103:3773/pair#token=PAIRCODE",
  );
});
