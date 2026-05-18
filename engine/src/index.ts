import "dotenv/config";
import { createClient } from "redis";
import { env } from "./utils/env.js";
import { BALANCES, FILLS, ORDERBOOKS, type OrderRecord, type OrderType, type Fill, type RestingOrder, ORDERS, type Balance, Minheap, type OrderBook } from "./store/exchange-store.js";

export type EngineCommandType =
  | "create_order"
  | "get_depth"
  | "get_user_balance"
  | "get_order"
  | "cancel_order"
  | "add_user_balance"

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

interface CreateOrderSchema{
  userId: string;
  qty: number;
  symbol: string;
  price: number;
  type: string;
  side: "buy" | "sell";
}
//  userId,
//     type,
//     side,
//     symbol,
//     price: type === "market" ? null : price,
//     qty,

const brokerClient = createClient({ url: env.redisUrl }).on("error", (error: any) => {
  console.error("Redis broker client error", error);
});

const responseClient = createClient({ url: env.redisUrl }).on("error", (error: any) => {
  console.error("Redis response client error", error);
});

await Promise.all([brokerClient.connect(), responseClient.connect()]);
const QUOTE = "USD";
// :-)) I added this just to check the flow, remove it when you start


// :-)) I added this just to check the flow, remove it when you start
const DUMMY_SELL_ORDER = {
  orderId: "dummy-sell-order-1",
  userId: "dummy-seller",
  type: "limit",
  side: "sell",
  symbol: "BTC",
  price: 100,
  qty: 1,
  filledQty: 0,
  status: "open",
};
const emptyBalane: Record<string,Balance> ={
  "USD":{available: 0, locked: 0},
  "SOL":{available:0, locked:0}
}

function getUsersBalance(userId: string): Record<string,Balance>{
 return BALANCES?.get(userId)??emptyBalane;
}

function ensureUserBalances(userId: string, symbol: string): Record<string, Balance> {
  let row = BALANCES.get(userId);
  if (!row) {
    row = {
      [QUOTE]: { available: 0, locked: 0 },
      [symbol]: { available: 0, locked: 0 },
    };
    BALANCES.set(userId, row);
  }
  if (!row[QUOTE]) row[QUOTE] = { available: 0, locked: 0 };
  if (!row[symbol]) row[symbol] = { available: 0, locked: 0 };
  return row;
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().replace(/^:+/, "");
}

function getOrCreateOrderBook(symbol: string): OrderBook {
  let book = ORDERBOOKS.get(symbol);
  if (!book) {
    book = {
      asks: new Map<number, RestingOrder[]>(),
      bids: new Map<number, RestingOrder[]>(),
      askHeap: new Minheap(),
      bidHeap: new Minheap(),
    };
    ORDERBOOKS.set(symbol, book);
  }
  return book;
}
async function sendResponse(responseQueue: string, response: EngineResponse): Promise<void> {
  await responseClient.lPush(responseQueue, JSON.stringify(response));
}

export function handleEngineRequest(message: EngineRequest): unknown {
  switch (message.type) {
   case "create_order" : {
   const payload = message.payload as unknown as CreateOrderSchema;
   const symbol = normalizeSymbol(payload.symbol);
   payload.symbol = symbol;
   const usersBalance = BALANCES.get(payload.userId as string)??{QUOTE:{available:0,locked:0},"SOL":{available: 0, locked:0}};
   const orderBook = getOrCreateOrderBook(symbol);

   let remainingQty = payload.qty;
   let filledQty = 0;
   let insufficientBalance = false;
     const order: OrderRecord= {
       userId: payload.userId,
       orderId: crypto.randomUUID(),
       qty: payload.qty,
       type: payload.type == "market"? "market": "limit",
       price: payload.type == "market"? null : (payload.price),
       filledQty: 0,
       side: payload.side,
       fills: [],
       status: "open",
       symbol: payload.symbol,
       createdAt: Date.now()
     }

     if( payload.type == "market"){           
             while(remainingQty >0){

               if (payload.side == "buy") {
                 if (orderBook?.asks.size == 0) {
                   break;
                 }

                //  if (orderBook?.askHeap.heap.length == 0) {
                //    break;
                //  }
                 const lowestPrice = orderBook?.askHeap.peek()??0;

                 //                not needed
                 let askOrders =
                   orderBook?.asks.get(lowestPrice) ?? [];

                //   if (!askOrders || askOrders.length === 0) {
                //    orderBook.askHeap.pop();
                //    break;

                //  }
                if (askOrders.length === 0) {
                  orderBook.askHeap.pop();
                  continue;
               }
                 for (const ask of askOrders) {

                   if (remainingQty == 0) break;

                  // const notional = fillQty * ask.price;
                   const quoteBal = usersBalance[QUOTE] ?? { available: 0, locked: 0 };
                   const baseBal = usersBalance[ask.symbol] ?? { available: 0, locked: 0 };
                   const affordableQty = quoteBal.available/ ask.price
                   if (affordableQty <= 0) {
                     insufficientBalance = true;
                     break;
                   }
                   const fillQty = Math.min(ask.qty,remainingQty, affordableQty );
                   const fill: Fill = {
                     fillId: crypto.randomUUID(),
                     buyOrderId: order.orderId,
                     sellOrderId: ask.orderId,
                     qty: fillQty,
                     price: ask.price,
                     symbol: ask.symbol,
                     createdAt: Date.now()
                   }


                   order.fills.push(fill);

                 
                   usersBalance[QUOTE] = {
                     ...quoteBal,
                     available: quoteBal.available as number - (fillQty * ask.price),
                   };
                   usersBalance[fill.symbol] = {
                     ...baseBal,
                     available: baseBal.available + fill.qty,
                   };
                   BALANCES.set(payload.userId, usersBalance);

                   const matchedUserBalance = getUsersBalance(ask.userId);
                   matchedUserBalance[QUOTE] = {
                     available: matchedUserBalance[QUOTE]?.available as number + (fillQty * ask.price),
                     locked: matchedUserBalance[QUOTE]?.locked as number
                   }

                   matchedUserBalance[fill.symbol] = {
                     available: matchedUserBalance[fill.symbol]?.available as number,
                     locked: matchedUserBalance[fill.symbol]?.locked as number - fill.qty
                   }

                   BALANCES.set(ask.userId, matchedUserBalance);
                   remainingQty -= fill.qty;
                   filledQty += fill.qty
                   ask.filledQty += fill.qty;
                   ask.qty -= fill.qty;

                   if (ask.qty == 0) {
                     ask.status = "filled"
                   }
                   else {
                     ask.status = "partially_filled"
                   }

                 }
                 if(insufficientBalance) break;
                 /// orderbook cleanup
                 askOrders = askOrders.filter(a => a.qty > 0);
                 if (askOrders.length == 0) {
                   orderBook.asks.delete(lowestPrice);
                   orderBook.askHeap.pop();
                 }
                 else {
                   orderBook.asks.set(lowestPrice, askOrders)
                 }
               }
               else {

                 //if(remainingQty == 0) break;

                 if (orderBook?.bids.size == 0) {
                  break;
                 }
                 const highestBidPrice = - Number(orderBook?.bidHeap.peek());
                 //orderBook?.bidHeap.pop();
                 //if(highestBidPrice == undefined) throw new Error("")
                 let bidOrders = orderBook.bids.get(highestBidPrice) ?? [];

                 if (bidOrders.length === 0) {
                  orderBook.bidHeap.pop();
                  continue;
               }

                 for (const bid of bidOrders) {

                  if(remainingQty== 0) break;
                   const availableStockBalance = usersBalance[payload.symbol]?.available as number;
                   const fillQty = Math.min(bid.qty, remainingQty, availableStockBalance);
                  // check users balance

                   if(availableStockBalance <= 0 ){
                    insufficientBalance = true;
                    break;
                   }
                   
                   const fill: Fill = {
                     fillId: crypto.randomUUID(),
                     buyOrderId: bid.orderId,
                     sellOrderId: order.orderId,
                     price: bid.price,
                     qty: fillQty,
                     symbol: bid.symbol,
                     createdAt: Date.now()
                   }

                   usersBalance[QUOTE] = {
                     available: usersBalance![QUOTE]?.available as number + fillQty * bid.price as number,
                     locked: usersBalance![QUOTE]?.locked as number
                   }

                   usersBalance![payload.symbol] = {
                     available: usersBalance![payload.symbol]?.available as number - fillQty,
                     locked: usersBalance![payload.symbol]?.locked as number
                   }
                   const matchedUserBalance = getUsersBalance(bid.userId);
                   matchedUserBalance[QUOTE] = {
                     available: matchedUserBalance[QUOTE]?.available as number,
                     locked: matchedUserBalance[QUOTE]?.locked as number - fillQty * bid.price
                   }
                   matchedUserBalance[payload.symbol] = {
                     available: matchedUserBalance[payload.symbol]?.available as number + fillQty,
                     locked: matchedUserBalance[payload.symbol]?.locked as number
                   }

                   BALANCES.set(payload.userId, {
                     ...usersBalance,

                   });

                   BALANCES.set(bid.userId, {
                     ...matchedUserBalance
                   })
                   bid.filledQty += fillQty;
                   bid.qty -= fillQty;

                   if (bid.qty === 0) {
                     bid.status = "filled";

                   }
                   else {
                     bid.status = "partially_filled";
                   }

                   order.fills.push(fill);

                   remainingQty -= fillQty;
                   filledQty += fillQty;

                 }

                 if(insufficientBalance) break;
                 // orderbook clean up
                 bidOrders = bidOrders?.filter(bid => bid.qty > 0);
                 if (bidOrders?.length == 0) {
                   orderBook.bids.delete(highestBidPrice);
                   orderBook.bidHeap.pop();

                 }
                 else {
                   orderBook.bids.set(highestBidPrice, bidOrders);
                 }

               }       
             }
     }

   if (payload.type == "limit") {
     const usersBalance = ensureUserBalances(payload.userId, payload.symbol);
     const side = payload.side;

     
      if(side == "buy"){
        const quoteAvailable = usersBalance[QUOTE]?.available ?? 0;
        const requiredQuote = payload.price * payload.qty;
        if (quoteAvailable < requiredQuote) {
          throw new Error(
            `Insufficient balance: need ${requiredQuote} ${QUOTE}, have ${quoteAvailable} ${QUOTE}`,
          );
        }
        usersBalance[QUOTE]={
          available: quoteAvailable - requiredQuote,
          locked: (usersBalance[QUOTE]?.locked ?? 0) + requiredQuote,
        }
      }
      else{
        const baseAvailable = usersBalance[payload.symbol]?.available ?? 0;
        if (baseAvailable < payload.qty) {
          throw new Error(
            `Insufficient quantity: need ${payload.qty} ${payload.symbol}, have ${baseAvailable}`,
          );
        }
        usersBalance[payload.symbol]={
          available: baseAvailable - payload.qty,
          locked: (usersBalance[payload.symbol]?.locked ?? 0) + payload.qty,
        }
      }
      BALANCES.set(payload.userId, { ...usersBalance });

     while (remainingQty > 0) {
       if (payload.side == "buy") {
        
         //throw new Error("Insufficient balance");
         const lowestPrice = orderBook?.askHeap.peek() as number;
         if(lowestPrice == null || lowestPrice == undefined || lowestPrice > payload.price) break;

           let askOrders = orderBook?.asks.get(lowestPrice);
           for (let ask of askOrders!) {
             if (remainingQty == 0) break;
             const fillQty = Math.min(ask.qty, remainingQty);
             filledQty += fillQty;
             remainingQty -= fillQty;
             const fill: Fill = {
               fillId: crypto.randomUUID(),
               buyOrderId: order.orderId,
               sellOrderId: ask.orderId,
               price: ask.price,
               qty: fillQty,
               symbol: payload.symbol,
               createdAt: Date.now()
             }

             order.fills.push(fill);
             usersBalance[payload.symbol] = {
               available: usersBalance[payload.symbol]?.available as number + fillQty,
               locked: usersBalance[payload.symbol]?.locked ?? 0 as number
             }
             usersBalance[QUOTE] = {
               available: usersBalance[QUOTE]?.available as number + ((payload.price * fillQty) - (ask.price * fillQty)),
               locked: usersBalance[QUOTE]?.locked ?? 0 as number - (payload.price * fillQty)
             }

             const makerBalance = getUsersBalance(ask.userId);
             makerBalance[QUOTE] = {
               available: makerBalance[QUOTE]?.available as number + (ask.price * fillQty),
               locked: makerBalance[QUOTE]?.locked as number
             }

             makerBalance[payload.symbol] = {
               available: makerBalance[payload.symbol]?.available as number,
               locked: makerBalance[payload.symbol]?.locked as number - fillQty
             }

             BALANCES.set(payload.userId, { ...usersBalance });
             BALANCES.set(ask.userId, { ...makerBalance });

             ask.filledQty += fillQty;
             ask.qty -= fillQty;

             if (ask.qty === 0) {
               ask.status = "filled"
             }
             else {
               ask.status = "partially_filled"
             }

           }
           askOrders = askOrders?.filter(a => a.qty > 0) ?? [];
           if (askOrders?.length == 0) {
             orderBook?.asks.delete(lowestPrice);
             orderBook?.askHeap.pop();

           }
           else {
             orderBook?.asks.set(lowestPrice, askOrders)
           }

       } else if (payload.side == "sell") {
        
         let maxBidPrice = orderBook?.bidHeap.peek();

         if(maxBidPrice == null || maxBidPrice == undefined || (-maxBidPrice) < payload.price) break;
         maxBidPrice = maxBidPrice != null ? -maxBidPrice : maxBidPrice;
           let bidOrders = orderBook?.bids.get(maxBidPrice as unknown as number);

           for (const bid of bidOrders!) {
             if (remainingQty == 0) break;
             const currentFillQty = bid.qty > remainingQty ? remainingQty : bid.qty
             filledQty += currentFillQty;
             remainingQty -= currentFillQty;

             const fill: Fill = {
               fillId: crypto.randomUUID(),
               buyOrderId: bid.orderId,
               sellOrderId: order.orderId,
               price: bid.price as unknown as number,
               qty: currentFillQty,
               createdAt: Date.now(),
               symbol: bid.symbol
             }
             order.fills.push(fill);

             bid.filledQty += currentFillQty;
             bid.qty -= currentFillQty;

             if (bid.qty == 0) {
               bid.status = "filled"
             }
             else {
               bid.status = "partially_filled"
             }

             usersBalance[payload.symbol] = {
               available: usersBalance[payload.symbol]?.available as number ,
               locked: usersBalance[payload.symbol]?.locked as number - currentFillQty
             }

             usersBalance[QUOTE] = {
               available: usersBalance[QUOTE]?.available as number + bid.price * currentFillQty,
               locked: usersBalance[QUOTE]?.locked as number
             }
             let makersBalance = getUsersBalance(bid.userId);
             makersBalance[payload.symbol] = {
               available: makersBalance[payload.symbol]?.available as number + currentFillQty,
               locked: makersBalance[payload.symbol]?.locked as number
             }

             makersBalance[QUOTE] = {
               available: makersBalance[QUOTE]?.available as number,
               locked: makersBalance[QUOTE]?.locked as number - bid.price * currentFillQty
             }

             BALANCES.set(payload.userId, { ...usersBalance });
             BALANCES.set(bid.userId, { ...makersBalance });

           }
           bidOrders = bidOrders?.filter(a => a.qty > 0) ?? []
           if (bidOrders?.length == 0) {
             orderBook?.bids.delete(maxBidPrice as number)
             orderBook?.bidHeap.pop();
           }
           else {
             orderBook?.bids.set(maxBidPrice as number, bidOrders)
           }
       }
     }

     if (remainingQty > 0 && payload.side == "buy") {

      const restingOrder: RestingOrder = {
        orderId: order.orderId,
        userId: payload.userId,
        filledQty: filledQty,
        status: filledQty == 0
          ? "open"
          : "partially_filled",
        price: payload.price,
        qty: remainingQty,
        side: "buy",
        symbol: payload.symbol,
        type: "limit",
        createdAt: Date.now()
      }

      const restingOrdersAtLimitPrice =
        orderBook.bids.get(payload.price as unknown as number) ?? [];
      restingOrdersAtLimitPrice.push(restingOrder);
      if (!orderBook.bids.has(payload.price as unknown as number)) {
        orderBook.bidHeap.push(-payload.price);
      }
      orderBook.bids.set(payload.price as unknown as number, restingOrdersAtLimitPrice);

      BALANCES.set(payload.userId, { ...usersBalance })


    }

    if (remainingQty > 0 && payload.side == "sell")  {
      // if (usersBalance[payload.symbol]?.available as number < payload.qty) {
      //   throw new Error("Insufficient balance");
      // }
      /// sit on orderbook
      const existingasksOnlimitPrice = orderBook?.asks.get(payload.price as unknown as number);
      const restingOrder: RestingOrder = {
        orderId: order.orderId,
        price: payload.price,
        qty: remainingQty,
        side: "sell",
        status: filledQty == 0 ? "open": "partially_filled",
        symbol: payload.symbol,
        type: "limit",
        userId: payload.userId,
        createdAt: Date.now(),
        filledQty: filledQty
      }


      if (existingasksOnlimitPrice) {
        existingasksOnlimitPrice.push(restingOrder);
        orderBook.asks.set(payload.price as unknown as number, existingasksOnlimitPrice);
      } else {
        orderBook.askHeap.push(payload.price);
        orderBook.asks.set(payload.price as unknown as number, [restingOrder]);
      }

      BALANCES.set(payload.userId, { ...usersBalance });

    }
   }
         
   if(payload.type === "market"){
    if(remainingQty > 0){
       order.status = filledQty > 0
         ? "partially_filled"
         : "cancelled";
    } else {
       order.status = "filled";
    }
 }
 else{
    if (filledQty === 0) {
       order.status = "open";
    } else if (filledQty < payload.qty) {
       order.status = "partially_filled";
    } else {
       order.status = "filled";
    }
 }
     order.filledQty = filledQty;
     ORDERS.set(order.orderId, order);
   return {
     orderId: order.orderId,
     status: order.status,
     filledQty: filledQty,
     averagePrice: order.fills.length >0 ? order.fills.reduce((a,b)=>a+ b.qty * b.price,0) / order.fills.reduce((a,b)=> a+ b.qty,0) : 0,
     fills: order.fills,                          
   };

  
  }
  case "get_user_balance":{
    return getUsersBalance(message.payload.userId as string);
  }
  case "get_order": {
    return ORDERS.get(message.payload.orderId as string);
  }
  case "cancel_order": {
    const existingorder = ORDERS.get(message.payload.orderId as string);
    if(!existingorder){
      throw new Error("Order does not exist");
    };

    if(existingorder && existingorder.type == "limit"){

        if(existingorder.status === "filled" || existingorder.status == "cancelled"){
          throw new Error("Order can not be cancelled");
        }

      
      else if(existingorder.status =="partially_filled" || existingorder.status == "open"){
        const side = existingorder.side;
        const price = existingorder.price;
        const asset = existingorder.symbol;
        let orderbook = ORDERBOOKS.get(asset) as OrderBook;
          if(side == "buy"){
           
            const Allorders = orderbook.bids.get(price as number) as RestingOrder[];
            const AllordersExceptCancelledOrder = Allorders?.filter(a=>a.orderId!= existingorder.orderId);
          
              orderbook.bids.set(price as number,[...AllordersExceptCancelledOrder!])
            
            
            const usersBalance = getUsersBalance(existingorder.userId);
            let stockBalance = usersBalance[QUOTE];

            usersBalance[QUOTE] ={
              available: stockBalance?.available as number + (existingorder.qty - existingorder.filledQty) * (existingorder.price!) as number,
              locked: stockBalance?.locked as number - (existingorder.qty - existingorder.filledQty) * (existingorder.price!) as number
            }
            if(AllordersExceptCancelledOrder.length == 0){
              orderbook.bids.delete(price as number);
              if(-Number(orderbook.bidHeap.peek()) == (price as number)){
                orderbook.bidHeap.pop()
              }
            }
            BALANCES.set(existingorder.userId, {...usersBalance} )
          }

          else if(side =="sell"){
            const Allorders = orderbook.asks.get(price as number);
            const AllordersExceptCancelledOrder = Allorders?.filter(a=>a.orderId!= existingorder.orderId);
            orderbook.asks.set(price as number,[...AllordersExceptCancelledOrder!])
            
            const usersBalance = getUsersBalance(existingorder.userId);
            usersBalance[existingorder.symbol] ={
              available : usersBalance[existingorder.symbol]?.available as number + existingorder.qty - existingorder.filledQty,
              locked: usersBalance[existingorder.symbol]?.locked as number - (existingorder.qty - existingorder.filledQty)
            }

            if(AllordersExceptCancelledOrder?.length == 0){
              orderbook.asks.delete(price as number);
              if(orderbook.askHeap.peek() == price){
                  orderbook.askHeap.pop();
              }
            }
            BALANCES.set(existingorder.userId, {...usersBalance});
          }
          ORDERBOOKS.set(asset, orderbook as OrderBook); 
      }

      existingorder.status = "cancelled";

      ORDERS.set(existingorder.orderId, {...existingorder});

      return {
        orderId: existingorder.orderId,
        status: "cancelled",
        cancelledQty:
          existingorder.qty - existingorder.filledQty
      }
    }
  }
  break;
  case "get_depth": {

    const symbol = normalizeSymbol(String(message.payload.symbol ?? ""));
    if (!symbol) {
      throw new Error("symbol is required");
    }
  
    type Bid = {
      price: number,
      qty: number
    };
  
    type Ask = {
      price: number,
      qty: number
    };
  
    type DepthResponse = {
      bids: Bid[],
      asks: Ask[]
    };
  
    const orderbook = ORDERBOOKS.get(symbol as string);
  
    if (!orderbook) {
      return { bids: [], asks: [] };
    }
  
    const bids: Bid[] = [];
    const asks: Ask[] = [];
  
    // bids
    for (const [price, orders] of orderbook.bids.entries()) {
  
      const qty = orders.reduce(
        (sum, order) => sum + order.qty,
        0
      );
  
      if (qty > 0) {
        bids.push({
          price,
          qty
        });
      }
    }
  
    // asks
    for (const [price, orders] of orderbook.asks.entries()) {
  
      const qty = orders.reduce(
        (sum, order) => sum + order.qty,
        0
      );
  
      if (qty > 0) {
        asks.push({
          price,
          qty
        });
      }
    }
  
    // sort bids descending
    bids.sort((a, b) => b.price - a.price);
  
    // sort asks ascending
    asks.sort((a, b) => a.price - b.price);
  
    const response: DepthResponse = {
      bids,
      asks
    };
  
    return response;
  }
  
  case "add_user_balance": {
    const { userId, key, balance } = message.payload;

    if (typeof userId !== "string" || typeof key !== "string" || key.length === 0) {
      throw new Error("invalid_add_balance_payload: userId and key are required");
    }
    if (typeof balance !== "number" || !Number.isFinite(balance) || balance <= 0) {
      throw new Error("invalid_add_balance_payload: balance must be a positive number");
    }

    const usersBalance = BALANCES.get(userId) ?? {
      [QUOTE]: { available: 0, locked: 0 },
      BTC: { available: 0, locked: 0 },
    };

    usersBalance[key] = {
      available: (usersBalance[key]?.available ?? 0) + balance,
      locked: usersBalance[key]?.locked ?? 0,
    };
    BALANCES.set(userId, { ...usersBalance });

    return usersBalance;
  }
  break;
  }
}


  console.log(`Engine listening on Redis queue: ${env.incomingQueue}`);

  for (;;) {
    const item = await brokerClient.brPop(env.incomingQueue, 0);
    if (!item) continue;

    let message: EngineRequest;

    try {
      message = JSON.parse(item.element) as EngineRequest;
    } catch {
      console.error("Skipping invalid broker message");
      continue;
    }

    try {
      const data = handleEngineRequest(message);
      await sendResponse(message.responseQueue, {
        correlationId: message.correlationId,
        ok: true,
        data,
      });
    } catch (error) {
      await sendResponse(message.responseQueue, {
        correlationId: message.correlationId,
        ok: false,
        error: error instanceof Error ? error.message : "engine_error",
      });
    }
  }
