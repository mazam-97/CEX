export type EngineCommandType =
  | "create_order"
  | "get_depth"
  | "get_user_balance"
  | "get_order"
  | "cancel_order";

export interface EngineRequest {
  correlationId: string;
  responseQueue: string;
  type: EngineCommandType;
  payload: Record<string, unknown>;
}

export interface EngineResponse {
  correlationId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}
 

/** Payload for `create_order` — mirrors validated HTTP body plus authenticated user. */
export interface CreateOrderPayload {
  userId: string;
  type: "limit" | "market";
  side: "buy" | "sell";
  symbol: string;
  price: number | null;
  qty: number;
}
