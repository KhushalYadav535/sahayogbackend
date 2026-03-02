/**
 * Bytez API — Chat completions using env model
 * POST https://api.bytez.com/models/v2/{modelId}
 * Header: Authorization: {BYTEZ_API_KEY}
 */
const BYTEZ_BASE = "https://api.bytez.com/models/v2";
const MODEL = process.env.BYTEZ_MODEL || "Qwen/Qwen3-4B";

export async function bytezChat(messages: { role: string; content: string }[], params?: { temperature?: number }) {
  const key = process.env.BYTEZ_API_KEY;
  if (!key) throw new Error("BYTEZ_API_KEY not configured");

  const body: Record<string, unknown> = { messages };
  if (params?.temperature !== undefined) body.params = { temperature: params.temperature };

  const res = await fetch(`${BYTEZ_BASE}/${encodeURIComponent(MODEL)}`, {
    method: "POST",
    headers: {
      Authorization: key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { message?: string }).message || "Bytez API error");

  const output = (data as { output?: string }).output;
  return typeof output === "string" ? output : "";
}
