import {
  BALANCES,
  FILLS,
  ORDERBOOKS,
  ORDERS,
  Minheap,
  type Balance,
  type Fill,
  type OrderBook,
  type OrderRecord,
  type OrderStatus,
  type RestingOrder,
  type Side,
} from "./store/exchange-store.js";

/** Quote asset for all symbols in this boilerplate (e.g. BTC / USDT). */
const QUOTE = "USDT";

export interface CreateOrderPayload {
  userId: string;
  type: "limit" | "market";
  side: Side;
  symbol: string;
  price: number | null;
  qty: number;
}

export interface CreateOrderHttpResponse {
  orderId: string;
  status: OrderStatus;
  filledQty: number;
  averagePrice: number | null;
  fills: Array<{
    fillId: string;
    symbol: string;
    price: number;
    qty: number;
    buyOrderId: string;
    sellOrderId: string;
  }>;
}

function parseCreateOrderPayload(raw: Record<string, unknown>): CreateOrderPayload {
  const userId = raw.userId;
  const type = raw.type;
  const side = raw.side;
  const symbol = raw.symbol;
  const qty = raw.qty;
  const price = raw.price;

  if (typeof userId !== "string" || userId.length === 0) {
    throw new Error("invalid_create_order_payload: userId");
  }
  if (type !== "limit" && type !== "market") {
    throw new Error("invalid_create_order_payload: type");
  }
  if (side !== "buy" && side !== "sell") {
    throw new Error("invalid_create_order_payload: side");
  }
  if (typeof symbol !== "string" || symbol.length === 0) {
    throw new Error("invalid_create_order_payload: symbol");
  }
  if (typeof qty !== "number" || !Number.isFinite(qty) || qty <= 0) {
    throw new Error("invalid_create_order_payload: qty");
  }
  if (type === "limit") {
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      throw new Error("invalid_create_order_payload: limit price");
    }
    return { userId, type, side, symbol, price, qty };
  }
  if (price !== null && price !== undefined) {
    throw new Error("invalid_create_order_payload: market price must be null");
  }
  return { userId, type, side, symbol, price: null, qty };
}

function ensureBalanceRow(userId: string, asset: string): Balance {
  let row = BALANCES.get(userId);
  if (!row) {
    row = {};
    BALANCES.set(userId, row);
  }
  if (!row[asset]) {
    row[asset] = { available: 0, locked: 0 };
  }
  return row[asset]!;
}

/** Seed generous balances on first touch so the demo flow works without a deposit API. */
export function ensureUserBalances(userId: string, symbol: string): void {
  ensureBalanceRow(userId, QUOTE);
  ensureBalanceRow(userId, symbol);
  const row = BALANCES.get(userId)!;
  if (row[QUOTE]!.available === 0 && row[QUOTE]!.locked === 0) {
    row[QUOTE]!.available = 1_000_000;
  }
  if (row[symbol]!.available === 0 && row[symbol]!.locked === 0) {
    row[symbol]!.available = 100_000;
  }
}

function emptyOrderBook(): OrderBook {
  return {
    bids: new Map(),
    asks: new Map(),
    askHeap: new Minheap(),
    bidHeap: new Minheap(),
  };
}

function getOrCreateOrderBook(symbol: string): OrderBook {
  let book = ORDERBOOKS.get(symbol);
  if (!book) {
    book = emptyOrderBook();
    ORDERBOOKS.set(symbol, book);
  }
  return book;
}

function sortedAskPrices(book: OrderBook): number[] {
  return [...book.asks.keys()]
    .filter((px) => (book.asks.get(px)?.length ?? 0) > 0)
    .sort((a, b) => a - b);
}

function sortedBidPrices(book: OrderBook): number[] {
  return [...book.bids.keys()]
    .filter((px) => (book.bids.get(px)?.length ?? 0) > 0)
    .sort((a, b) => b - a);
}

function prunePriceLevel(
  book: OrderBook,
  side: "buy" | "sell",
  price: number,
): void {
  const map = side === "buy" ? book.bids : book.asks;
  const arr = map.get(price);
  if (arr && arr.length === 0) {
    map.delete(price);
  }
}

function spliceNextMaker(
  queue: RestingOrder[],
  takerUserId: string,
): RestingOrder | null {
  for (let i = 0; i < queue.length; i++) {
    const o = queue[i]!;
    if (o.userId !== takerUserId) {
      queue.splice(i, 1);
      return o;
    }
  }
  return null;
}

function recordFillOnOrder(orderId: string, fill: Fill, fillQty: number): void {
  const rec = ORDERS.get(orderId);
  if (!rec) return;
  rec.fills.push(fill);
  rec.filledQty += fillQty;
  if (rec.filledQty >= rec.qty) {
    rec.filledQty = rec.qty;
    rec.status = "filled";
  } else if (rec.filledQty > 0) {
    rec.status = "partially_filled";
  }
}

function applyTrade(
  symbol: string,
  price: number,
  qty: number,
  buyerUserId: string,
  sellerUserId: string,
  buyOrderId: string,
  sellOrderId: string,
): void {
  const cost = price * qty;
  const buyer = BALANCES.get(buyerUserId)!;
  const seller = BALANCES.get(sellerUserId)!;
  buyer[QUOTE]!.available -= cost;
  buyer[symbol]!.available += qty;
  seller[symbol]!.available -= qty;
  seller[QUOTE]!.available += cost;

  const fill: Fill = {
    fillId: randomUUID(),
    symbol,
    price,
    qty,
    buyOrderId,
    sellOrderId,
    createdAt: Date.now(),
  };
  FILLS.push(fill);
  recordFillOnOrder(buyOrderId, fill, qty);
  recordFillOnOrder(sellOrderId, fill, qty);
}

function addRestingOrder(book: OrderBook, side: Side, order: RestingOrder): void {
  const map = side === "buy" ? book.bids : book.asks;
  const list = map.get(order.price) ?? [];
  list.push(order);
  map.set(order.price, list);
}

function finalizeTakerRecord(rec: OrderRecord, restingPlaced: boolean): void {
  if (rec.status === "filled") return;
  if (restingPlaced) {
    rec.status = rec.filledQty > 0 ? "partially_filled" : "open";
  } else if (rec.filledQty > 0 && rec.filledQty < rec.qty) {
    rec.status = "partially_filled";
  } else if (rec.filledQty === 0) {
    rec.status = "open";
  }
}

function toHttpFills(fills: Fill[]): CreateOrderHttpResponse["fills"] {
  return fills.map((f) => ({
    fillId: f.fillId,
    symbol: f.symbol,
    price: f.price,
    qty: f.qty,
    buyOrderId: f.buyOrderId,
    sellOrderId: f.sellOrderId,
  }));
}

function averageFillPrice(fills: Fill[]): number | null {
  if (fills.length === 0) return null;
  let notional = 0;
  let qty = 0;
  for (const f of fills) {
    notional += f.price * f.qty;
    qty += f.qty;
  }
  return qty > 0 ? notional / qty : null;
}

/** Bun / modern runtimes expose Web Crypto on `globalThis`. */
function randomUUID(): string {
  const c = globalThis as unknown as { crypto?: { randomUUID(): string } };
  if (!c.crypto?.randomUUID) {
    throw new Error("crypto.randomUUID is not available");
  }
  return c.crypto.randomUUID();
}

export function executeCreateOrder(rawPayload: Record<string, unknown>): CreateOrderHttpResponse {
  const p = parseCreateOrderPayload(rawPayload);
  ensureUserBalances(p.userId, p.symbol);
  const book = getOrCreateOrderBook(p.symbol);

  const orderId = randomUUID();
  const takerRecord: OrderRecord = {
    orderId,
    userId: p.userId,
    side: p.side,
    type: p.type,
    symbol: p.symbol,
    price: p.type === "limit" ? p.price! : null,
    qty: p.qty,
    filledQty: 0,
    status: "open",
    fills: [],
    createdAt: Date.now(),
  };
  ORDERS.set(orderId, takerRecord);

  try {
    let remaining = p.qty;
    let restingPlaced = false;

    if (p.type === "limit" && p.side === "buy") {
    const limitPrice = p.price!;
    const usdt = BALANCES.get(p.userId)![QUOTE]!;
    if (usdt.available < limitPrice * p.qty) {
      throw new Error("insufficient_balance");
    }

    for (const askPx of sortedAskPrices(book)) {
      if (remaining <= 0) break;
      if (askPx > limitPrice) break;
      const queue = book.asks.get(askPx);
      if (!queue) continue;

      while (remaining > 0 && queue.length > 0) {
        const maker = spliceNextMaker(queue, p.userId);
        if (!maker) break;

        const tradeQty = Math.min(remaining, maker.qty);
        applyTrade(
          p.symbol,
          askPx,
          tradeQty,
          p.userId,
          maker.userId,
          orderId,
          maker.orderId,
        );

        remaining -= tradeQty;
        maker.qty -= tradeQty;
        maker.filledQty += tradeQty;
        maker.status = maker.qty <= 0 ? "filled" : "partially_filled";

        if (maker.qty <= 0) {
          prunePriceLevel(book, "sell", askPx);
        } else {
          queue.unshift(maker);
        }
      }
      prunePriceLevel(book, "sell", askPx);
    }

    if (remaining > 0) {
      const reserve = limitPrice * remaining;
      BALANCES.get(p.userId)![QUOTE]!.available -= reserve;

      const resting: RestingOrder = {
        orderId,
        userId: p.userId,
        side: "buy",
        type: "limit",
        symbol: p.symbol,
        price: limitPrice,
        qty: remaining,
        filledQty: p.qty - remaining,
        status: p.qty === remaining ? "open" : "partially_filled",
        createdAt: Date.now(),
      };
      addRestingOrder(book, "buy", resting);
      restingPlaced = true;
    }
  } else if (p.type === "limit" && p.side === "sell") {
    const limitPrice = p.price!;
    const base = BALANCES.get(p.userId)![p.symbol]!;
    if (base.available < p.qty) {
      throw new Error("insufficient_balance");
    }

    for (const bidPx of sortedBidPrices(book)) {
      if (remaining <= 0) break;
      if (bidPx < limitPrice) break;
      const queue = book.bids.get(bidPx);
      if (!queue) continue;

      while (remaining > 0 && queue.length > 0) {
        const maker = spliceNextMaker(queue, p.userId);
        if (!maker) break;

        const tradeQty = Math.min(remaining, maker.qty);
        applyTrade(
          p.symbol,
          bidPx,
          tradeQty,
          maker.userId,
          p.userId,
          maker.orderId,
          orderId,
        );

        remaining -= tradeQty;
        maker.qty -= tradeQty;
        maker.filledQty += tradeQty;
        maker.status = maker.qty <= 0 ? "filled" : "partially_filled";

        if (maker.qty <= 0) {
          prunePriceLevel(book, "buy", bidPx);
        } else {
          queue.unshift(maker);
        }
      }
      prunePriceLevel(book, "buy", bidPx);
    }

    if (remaining > 0) {
      BALANCES.get(p.userId)![p.symbol]!.available -= remaining;

      const resting: RestingOrder = {
        orderId,
        userId: p.userId,
        side: "sell",
        type: "limit",
        symbol: p.symbol,
        price: limitPrice,
        qty: remaining,
        filledQty: p.qty - remaining,
        status: p.qty === remaining ? "open" : "partially_filled",
        createdAt: Date.now(),
      };
      addRestingOrder(book, "sell", resting);
      restingPlaced = true;
    }
  } else if (p.type === "market" && p.side === "buy") {
    walkAsks: for (const askPx of sortedAskPrices(book)) {
      if (remaining <= 0) break;
      const queue = book.asks.get(askPx);
      if (!queue) continue;

      while (remaining > 0 && queue.length > 0) {
        const maker = spliceNextMaker(queue, p.userId);
        if (!maker) break;

        const maxByBalance = Math.floor(BALANCES.get(p.userId)![QUOTE]!.available / askPx);
        if (maxByBalance <= 0) {
          if (takerRecord.fills.length === 0) {
            throw new Error("insufficient_balance");
          }
          break walkAsks;
        }
        const tradeQty = Math.min(remaining, maker.qty, maxByBalance);

        applyTrade(
          p.symbol,
          askPx,
          tradeQty,
          p.userId,
          maker.userId,
          orderId,
          maker.orderId,
        );

        remaining -= tradeQty;
        maker.qty -= tradeQty;
        maker.filledQty += tradeQty;
        maker.status = maker.qty <= 0 ? "filled" : "partially_filled";

        if (maker.qty <= 0) {
          prunePriceLevel(book, "sell", askPx);
        } else {
          queue.unshift(maker);
        }
      }
      prunePriceLevel(book, "sell", askPx);
      if (remaining <= 0) break;
    }

    if (remaining === p.qty && takerRecord.fills.length === 0) {
      throw new Error("no_liquidity");
    }
  } else if (p.type === "market" && p.side === "sell") {
    const base = BALANCES.get(p.userId)![p.symbol]!;
    if (base.available < p.qty) {
      throw new Error("insufficient_balance");
    }

    for (const bidPx of sortedBidPrices(book)) {
      if (remaining <= 0) break;
      const queue = book.bids.get(bidPx);
      if (!queue) continue;

      while (remaining > 0 && queue.length > 0) {
        const maker = spliceNextMaker(queue, p.userId);
        if (!maker) break;

        const tradeQty = Math.min(remaining, maker.qty);
        applyTrade(
          p.symbol,
          bidPx,
          tradeQty,
          maker.userId,
          p.userId,
          maker.orderId,
          orderId,
        );

        remaining -= tradeQty;
        maker.qty -= tradeQty;
        maker.filledQty += tradeQty;
        maker.status = maker.qty <= 0 ? "filled" : "partially_filled";

        if (maker.qty <= 0) {
          prunePriceLevel(book, "buy", bidPx);
        } else {
          queue.unshift(maker);
        }
      }
      prunePriceLevel(book, "buy", bidPx);
    }

    if (remaining === p.qty && takerRecord.fills.length === 0) {
      throw new Error("no_liquidity");
    }
  }

    takerRecord.filledQty = p.qty - remaining;

    if (takerRecord.filledQty >= p.qty) {
      takerRecord.status = "filled";
    } else {
      finalizeTakerRecord(takerRecord, restingPlaced);
    }

    return {
      orderId,
      status: takerRecord.status,
      filledQty: takerRecord.filledQty,
      averagePrice: averageFillPrice(takerRecord.fills),
      fills: toHttpFills(takerRecord.fills),
    };
  } catch (err) {
    if (takerRecord.fills.length === 0) {
      ORDERS.delete(orderId);
    }
    throw err;
  }
}
