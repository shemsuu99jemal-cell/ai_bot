export type Language = "en" | "am";

export interface Product {
  id: string;
  name: string;
  description?: string | null;
  price: number;
  category?: string | null;
  image_url?: string | null;
}

export interface CartItem {
  product_id: string;
  name: string;
  price: number;
  quantity: number;
  color?: string | null;
}

export type OrderStatus =
  | "awaiting_payment"
  | "pending_verification"
  | "confirmed"
  | "rejected";

export interface Order {
  id: string;
  customer_telegram_id: number;
  customer_name: string;
  customer_phone?: string | null;
  delivery_location?: string | null;
  delivery_fee?: number;
  subtotal?: number;
  total: number;
  status: OrderStatus;
  screenshot_url?: string | null;
  payment_method_id?: string | null;
  payment_method_name?: string | null;
  payment_account_number?: string | null;
  payment_account_name?: string | null;
  rejection_reason?: string | null;
  reminder_count?: number;
  created_at?: string;
  updated_at?: string;
}

export type PendingStep =
  | "awaiting_phone"
  | "awaiting_delivery_choice"
  | "awaiting_delivery_area"
  | "awaiting_payment_method"
  | "awaiting_reject_phone"
  | null;

export interface Session {
  language: Language;
  history: any[];
  cart: CartItem[];
  pendingOrderId: string | null;
  customerPhone?: string | null;
  deliveryLocation?: string | null;
  deliveryFee?: number;
  pendingStep?: PendingStep;
}

export interface PaymentMethod {
  id: string;
  name: string;
  account_number: string;
  account_name?: string | null;
  instructions?: string | null;
  is_active: boolean;
  created_at?: string;
}

export type AiResult =
  | { action: "reply"; text: string }
  | { action: "checkout" }
  | { action: "ask_seller"; question: string }
  | { action: "show_categories" }
  | { action: "show_customer_orders" };
