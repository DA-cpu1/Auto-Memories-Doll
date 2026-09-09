import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/config/ai/test/route";
import { GET as getAiConfig } from "../app/api/config/ai/route";
import { KnowledgeConfigService } from "../server/services/knowledge-config-service";

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/config/ai/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/config/ai/test", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([false, true])(
    "restores masked credentials from GET config, dedicated embedding key=%s",
    async (dedicated) => {
      const service = new KnowledgeConfigService();
      const config = service.getDefaultAiConfig();
      service.setAiConfig({
        ...config,
        apiKey: "stored-chat-secret",
        baseURL: "https://chat.example.com/v1",
        embedding: {
          ...config.embedding,
          apiKey: dedicated ? "stored-vector-secret" : "",
          baseURL: dedicated ? "https://vectors.example.com/v1" : "",
        },
      });
      const visible = await (await getAiConfig()).json();
      expect(visible.apiKey).toBe("****cret");
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ model: "chat-model" })))
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] })));
      vi.stubGlobal("fetch", fetchMock);
      const response = await POST(jsonRequest({ ...visible, model: visible.standard.model }));
      expect((await response.clone().json()).success).toBe(true);
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer stored-chat-secret");
      expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe(
        dedicated ? "Bearer stored-vector-secret" : "Bearer stored-chat-secret",
      );
      expect(await response.text()).not.toContain("stored-");
      service.close();
    },
  );

  it("does not forward stored credentials to a changed test endpoint", async () => {
    const service = new KnowledgeConfigService();
    service.setAiConfig({
      ...service.getDefaultAiConfig(),
      apiKey: "saved-secret",
      baseURL: "https://saved.example.com/v1",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await (
      await POST(
        jsonRequest({
          apiKey: "****cret",
          baseURL: "https://different.example.com/v1",
          embedding: { enabled: false },
        }),
      )
    ).json();
    expect(result.llm.success).toBe(false);
    expect(result.llm.message).toContain("端点已更改");
    expect(fetchMock).not.toHaveBeenCalled();
    service.close();
  });

  it("rejects a stale masked key locally instead of forwarding stars", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await (
      await POST(jsonRequest({ apiKey: "****nope", embedding: { enabled: false } }))
    ).json();
    expect(result.llm.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports HTTP 200 business failures accurately without leaking credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ base_resp: { status_code: 1004, status_msg: "invalid sent-secret" } }),
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ base_resp: { status_code: 2013, status_msg: "invalid model" } }),
          ),
        ),
    );
    const result = await (await POST(jsonRequest({ apiKey: "sent-secret" }))).json();
    expect(result.llm).toMatchObject({ success: false });
    expect(result.llm.message).toContain("1004");
    expect(result.embedding).toMatchObject({ success: false });
    expect(result.embedding.message).toContain("2013");
    expect(result.embedding.message).not.toContain("空向量");
    expect(JSON.stringify(result)).not.toContain("sent-secret");
  });

  it("returns independent chat and embedding connection results", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ model: "chat-model" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: "embedding-model",
            data: [{ embedding: [0.1, 0.2, 0.3] }],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      jsonRequest({
        baseURL: "https://chat.example.com/v1",
        apiKey: "chat-key",
        model: "chat-model",
        embedding: {
          baseURL: "https://embedding.example.com/v1",
          apiKey: "embedding-key",
          model: "embedding-model",
        },
      }),
    );
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.llm).toMatchObject({ success: true, model: "chat-model" });
    expect(body.embedding).toMatchObject({
      success: true,
      model: "embedding-model",
      dimensions: 3,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://embedding.example.com/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ model: "embedding-model", input: "health-check" }),
      }),
    );
  });

  it("keeps embedding failure visible when chat succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ model: "chat-model" }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { message: "embedding model not found" } }), {
            status: 404,
          }),
        ),
    );

    const response = await POST(
      jsonRequest({
        baseURL: "https://api.example.com/v1",
        apiKey: "shared-key",
        model: "chat-model",
        embedding: { model: "missing-embedding-model" },
      }),
    );
    const body = await response.json();

    expect(body.success).toBe(false);
    expect(body.llm).toMatchObject({ success: true });
    expect(body.embedding).toMatchObject({
      success: false,
      message: "embedding model not found",
    });
  });
});
