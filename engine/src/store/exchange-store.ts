export type Side = "buy" | "sell";
export type OrderType = "market" | "limit";
export type OrderStatus = "open" | "partially_filled" | "filled" | "cancelled";

export interface Balance {
  available: number;
  locked: number;
}

export interface RestingOrder {
  orderId: string;
  userId: string;
  side: Side;
  type: "limit";
  symbol: string;
  price: number;
  qty: number;
  filledQty: number;
  status: OrderStatus;
  createdAt: number;
}

export interface OrderRecord {
  orderId: string;
  userId: string;
  side: Side;
  type: OrderType;
  symbol: string;
  price: number | null;
  qty: number;
  filledQty: number;
  status: OrderStatus;
  fills: Fill[];
  createdAt: number;
}

export interface Fill {
  fillId: string;
  symbol: string;
  price: number;
  qty: number;
  buyOrderId: string;
  sellOrderId: string;
  createdAt: number;
}

export interface OrderBook {
  bids: Map<number, RestingOrder[]>;
  asks: Map<number, RestingOrder[]>;

  askHeap: Minheap;
  bidHeap: Minheap;
}

export interface CreateOrderInput {
  userId: string;
  type: OrderType;
  side: Side;
  symbol: string;
  price: number | null;
  qty: number;
}

export interface DepthLevel {
  price: number;
  qty: number;
}

export interface DepthResponse {
  symbol: string;
  bids: DepthLevel[];
  asks: DepthLevel[];
}

export class Minheap {
  heap: number[];
  constructor(){
    this.heap = [];
  }

  getParentIndex(index: number) {
    return Math.floor((index - 1) / 2);
  }

  getleftChildrenIndex(index: number){
    return 2 * index + 1;
  }

  getRightChildrenIndex(index: number){
    return 2 * index + 2;
  }
  push(value: number){

    this.heap.push(value);
    this.heapifyUp();
  }
  swap(i:number, j: number){
    return [this.heap[i] as any, this.heap[j] as any] = [this.heap[j], this.heap[i]];
  }
  peek(){
    if (this.heap.length === 0){
      return null;
    }
    return this.heap[0];
  }
  pop(){
    if(this.heap.length ===0){
      return null;
    }

    if(this.heap.length === 1){
      return this.heap.pop()
    }
    let min =  this.heap[0];
     this.heap[0]= this.heap.pop()!;
     this.heapifyDown();
     return min;

  }

  heapifyDown(): void {
    let index = 0;
  
    while (this.getleftChildrenIndex(index) as any < this.heap.length) {
      
      // assume left child is smaller
      let smallerChildIndex = this.getleftChildrenIndex(index) as number;
  
      const rightChildIndex = this.getRightChildrenIndex(index) as number;
  
      // if right child exists and is smaller
      if(smallerChildIndex == undefined || rightChildIndex == undefined) break;
      
      if (
        rightChildIndex < this.heap.length &&
        this.heap[rightChildIndex]as unknown as number <
          this.heap[smallerChildIndex]! as unknown as number
      ) {
        smallerChildIndex = rightChildIndex;
      }
  
      // heap property satisfied
      if (
        this.heap[index]! <=
        this.heap[smallerChildIndex]!
      ) {
        break;
      }
  
      // swap parent with smaller child
      this.swap(index, smallerChildIndex);
  
      // continue downward
      index = smallerChildIndex;
    }
  }
  heapifyUp() {
    let index = this.heap.length - 1;
    while (index > 0) {
      const parentIndex = this.getParentIndex(index);
      const child = this.heap[index];
      const parent = this.heap[parentIndex];
      if (child === undefined || parent === undefined) break;
      if (parent <= child) break;
      this.swap(index, parentIndex);
      index = parentIndex;
    }
  }
}

export const BALANCES = new Map<string, Record<string, Balance>>();
export const ORDERBOOKS = new Map<string, OrderBook>();
export const ORDERS = new Map<string, OrderRecord>();
export const FILLS: Fill[] = [];