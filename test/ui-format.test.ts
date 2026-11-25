import { describe, expect, it } from "vitest";
import { plainSummary, presentRequest, tint } from "../client/ui-format";

describe("tint", () => {
  it("turns hex and rgb theme colours into rgba", () => {
    expect(tint("#1e7a4c", 0.14)).toBe("rgba(30, 122, 76, 0.14)");
    expect(tint("#fff", 0.5)).toBe("rgba(255, 255, 255, 0.5)");
    expect(tint("rgb(123, 93, 57)", 0.14)).toBe("rgba(123, 93, 57, 0.14)");
    expect(tint("rgba(1,2,3,0.9)", 0.2)).toBe("rgba(1, 2, 3, 0.2)");
  });

  it("falls back to transparent for colours it cannot read", () => {
    expect(tint("hsl(10 20% 30%)", 0.1)).toBe("transparent");
    expect(tint("tomato", 0.1)).toBe("transparent");
  });
});

describe("presentRequest", () => {
  it("moves a shell command out of the title into a code block", () => {
    expect(presentRequest("Run cat > a.js <<'EOF'\nx\nEOF", null)).toEqual({ title: "Run this command", detail: "cat > a.js <<'EOF'\nx\nEOF" });
  });

  it("leaves other requests alone", () => {
    expect(presentRequest("Write /tmp/NOTES.md", null)).toEqual({ title: "Write /tmp/NOTES.md", detail: null });
    expect(presentRequest("Run tests", "npm test")).toEqual({ title: "Run tests", detail: "npm test" });
  });
});

describe("plainSummary", () => {
  it("drops markdown marks that would show as raw characters", () => {
    expect(plainSummary("I added `divide(a, b)` to **calc.js**.\n\n\n## Tests\n- one\n* two\n> quoted")).toBe("I added divide(a, b) to calc.js.\n\nTests\n• one\n• two\nquoted");
  });

  it("keeps code inside fences as it is", () => {
    expect(plainSummary("Added:\n\n```js\n/**\n * @param {number} a\n */\n```\n- done")).toBe("Added:\n\n/**\n * @param {number} a\n */\n• done");
  });
});
