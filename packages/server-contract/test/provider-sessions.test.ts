import { describe, expect, it } from "vitest";
import {
  importProviderSessionRequestSchema,
  providerSessionsQuerySchema,
} from "../src/index.js";

describe("provider session API boundaries", () => {
  it("requires explicit host routing and an opaque source key", () => {
    expect(providerSessionsQuerySchema.safeParse({}).success).toBe(false);
    expect(providerSessionsQuerySchema.safeParse({ hostId: "" }).success).toBe(
      false,
    );
    expect(providerSessionsQuerySchema.parse({ hostId: "host" })).toEqual({
      hostId: "host",
    });
    expect(
      importProviderSessionRequestSchema.safeParse({ hostId: "host" }).success,
    ).toBe(false);
    expect(
      importProviderSessionRequestSchema.safeParse({
        hostId: "host",
        sourceKey: "source",
        cwd: "/injected",
      }).success,
    ).toBe(false);
  });
});
