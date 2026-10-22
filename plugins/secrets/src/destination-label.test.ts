import { describe, expect, it } from "vitest";
import { lastFolderLabel, splitDestination } from "./destination-label.js";

describe("splitDestination", () => {
  it.each([
    [
      "/srv/app/credentials/.env.local",
      { stem: ".env", extension: ".local", folder: "/srv/app/credentials" },
    ],
    [
      "/srv/credentials/droplet-monitor-production-service.env.local",
      {
        stem: "droplet-monitor-production-service",
        extension: ".env.local",
        folder: "/srv/credentials",
      },
    ],
    ["/srv/app/.env", { stem: ".env", extension: "", folder: "/srv/app" }],
    ["/.env", { stem: ".env", extension: "", folder: "/" }],
    ["C:\\app\\.env", { stem: ".env", extension: "", folder: "C:\\app" }],
    ["C:\\.env", { stem: ".env", extension: "", folder: "C:\\" }],
    ["/srv/app/", { stem: "/srv/app/", extension: "", folder: null }],
    ["secrets.env", { stem: "secrets", extension: ".env", folder: null }],
    [
      "/srv/app/config.prod.json",
      { stem: "config.prod", extension: ".json", folder: "/srv/app" },
    ],
  ])("splits %s", (path, parts) => {
    expect(splitDestination(path)).toEqual(parts);
  });
});

describe("lastFolderLabel", () => {
  it.each([
    ["~/projects/app/credentials", "…/credentials"],
    ["/srv/app/credentials/", "…/credentials"],
    ["C:\\Users\\dev\\app", "…\\app"],
    ["/srv", "/srv"],
    ["C:\\app", "C:\\app"],
    ["C:\\", "C:\\"],
    ["/", "/"],
    ["~", "~"],
  ])("labels %s as %s", (folder, label) => {
    expect(lastFolderLabel(folder)).toBe(label);
  });
});
