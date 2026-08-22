import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/redactSecrets.js";

describe("redactSecrets", () => {
  it("redacts an OpenAI-style key", () => {
    expect(redactSecrets("error: key sk-abcdefghijklmnopqrstuvwxyz was rejected")).not.toContain("sk-abc");
  });

  it("redacts an Anthropic-style key", () => {
    const text = "auth failed for sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345";
    expect(redactSecrets(text)).not.toContain("AbCdEf");
    expect(redactSecrets(text)).toContain("[redacted]");
  });

  it("redacts an OpenRouter-style key", () => {
    const text = "using key sk-or-v1-0123456789abcdef0123456789abcdef";
    expect(redactSecrets(text)).not.toContain("0123456789abcdef");
  });

  it("redacts a Google API key", () => {
    expect(redactSecrets("key AIzaSyD-abcdefghijklmnopqrstuvwxyz1234")).not.toContain("AIzaSyD");
  });

  it("redacts a bearer token", () => {
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("leaves ordinary error text untouched", () => {
    const text = "Room kitchen not found on level level-0";
    expect(redactSecrets(text)).toBe(text);
  });
});
