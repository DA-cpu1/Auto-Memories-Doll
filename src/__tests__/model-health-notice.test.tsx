import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelHealthNotice } from "../components/common/DegradationBanner";
import type { ModelHealth } from "../types/model-health";

const healthy: ModelHealth = {
  degraded: false,
  degradedCapabilities: [],
  failures: [],
  timestamp: 0,
};

describe("current model status", () => {
  it("shows the failing model and cause, and disappears when recovery is confirmed", () => {
    const html = renderToStaticMarkup(
      <ModelHealthNotice
        health={{
          ...healthy,
          degraded: true,
          degradedCapabilities: ["llm"],
          failures: [
            {
              slot: "flagship",
              model: "sample-model",
              reason: "TIMEOUT",
              failedAt: "2026-09-10T00:00:00Z",
              durationMs: 60000,
              purpose: "processing",
            },
          ],
        }}
      />,
    );
    expect(html).toContain("旗舰模型");
    expect(html).toContain("sample-model");
    expect(html).toContain("调用超时");
    expect(html).toContain("60.0 秒");
    expect(renderToStaticMarkup(<ModelHealthNotice health={healthy} />)).toBe("");
  });

  it("does not present an unreachable health endpoint as a model outage", () => {
    const html = renderToStaticMarkup(<ModelHealthNotice health={healthy} stale />);
    expect(html).toContain("模型状态暂时无法更新");
    expect(html).not.toContain("AI 加工异常");
  });
});
