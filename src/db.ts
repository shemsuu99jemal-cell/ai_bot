import { createClient } from "@supabase/supabase-js";
import type {
  Product,
  Order,
  CartItem,
  Session,
  OrderStatus,
  PaymentMethod,
  StoreAddress,
} from "./types";

export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
);

export async function searchProducts(query: string): Promise<Product[]> {
  const q = query.trim();
  if (!q) return [];
  const safe = q.replace(/[,()]/g, "");
  if (!safe) return [];

  const { data, error } = await supabase
    .from("products")
    .select("*")
    .or(`name.ilike.%${safe}%,category.ilike.%${safe}%`)
    .limit(10);
  if (error) throw error;
  return data as Product[];
}

export async function getProduct(productId: string): Promise<Product> {
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .eq("id", productId)
    .single();
  if (error) throw error;
  return data as Product;
}

// ---- categories ----
// Cached in-process for 5 minutes since the category list rarely changes and
// this is called on nearly every "browse" interaction — avoids a DB round
// trip per tap and keeps the menu flow fast enough to feel instant.
let categoriesCache: { data: string[]; expires: number } | null = null;

export async function getCategories(): Promise<string[]> {
  if (categoriesCache && categoriesCache.expires > Date.now()) {
    return categoriesCache.data;
  }
  const { data, error } = await supabase
    .from("products")
    .select("category")
    .not("category", "is", null)
    .order("category", { ascending: true });
  if (error) throw error;

  const unique = Array.from(
    new Set((data || []).map((d) => d.category).filter(Boolean)),
  ) as string[];
  categoriesCache = { data: unique, expires: Date.now() + 5 * 60_000 };
  return unique;
}

export async function getProductsByCategory(
  category: string,
): Promise<Product[]> {
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .eq("category", category)
    .order("name", { ascending: true })
    .limit(20);
  if (error) throw error;
  return data as Product[];
}

export async function getRelatedProducts(
  productId: string,
  limit = 3,
): Promise<Product[]> {
  const product = await getProduct(productId).catch(() => null);
  if (!product) return [];

  const nameLower = (product.name || "").toLowerCase();
  const category = product.category || "";
  const isPhone =
    /iphone|samsung|galaxy|pixel|xiaomi|huawei|motorola|phone|smartphone/i.test(
      nameLower,
    ) || category === "Phones";
  const isAccessory =
    /charger|case|cable|airpods|earbuds|adapter|watch|protector|screen/i.test(
      nameLower,
    ) || category === "Accessories";

  const tryQuery = async (
    targetCategory: string | null,
    usePriceOrder = true,
  ) => {
    let query = supabase
      .from("products")
      .select("*")
      .neq("id", productId)
      .order("price", { ascending: usePriceOrder })
      .limit(limit);

    if (targetCategory) {
      query = query.eq("category", targetCategory);
    }

    const { data, error } = await query;
    if (error) throw error;
    return (data || []) as Product[];
  };

  if (isPhone) {
    const accessories = await tryQuery("Accessories", true).catch(() => []);
    if (accessories.length > 0) return accessories;
  }

  if (isAccessory) {
    const phones = await tryQuery("Phones", true).catch(() => []);
    if (phones.length > 0) return phones;
  }

  if (category) {
    const sameCategory = await tryQuery(category, true).catch(() => []);
    if (sameCategory.length > 0) return sameCategory;
  }

  return await tryQuery(null, true).catch(() => []);
}

// ---- product admin CRUD (seller only — gated in index.ts) ----

export async function createProduct(data: {
  name: string;
  description?: string | null;
  price: number;
  category?: string | null;
  colors?: string[] | null;
  image_url?: string | null;
}): Promise<Product> {
  const { data: product, error } = await supabase
    .from("products")
    .insert({
      name: data.name,
      description: data.description?.trim() || null,
      price: data.price,
      category: data.category?.trim().toLowerCase() || "general",
      image_url: data.image_url || null,
    })
    .select()
    .single();
  if (error) throw error;
  categoriesCache = null; // a new category may have just been introduced
  return product as Product;
}

export async function updateProduct(
  productId: string,
  updates: Partial<{
    name: string;
    description: string | null;
    price: number;
    category: string | null;
    image_url: string | null;
  }>,
): Promise<Product> {
  if (typeof updates.category === "string") {
    updates.category = updates.category.trim().toLowerCase();
  }
  if (typeof updates.description === "string") {
    updates.description = updates.description.trim() || null;
  }
  const { data, error } = await supabase
    .from("products")
    .update(updates)
    .eq("id", productId)
    .select()
    .single();
  if (error) throw error;
  categoriesCache = null;
  return data as Product;
}

export async function deleteProduct(productId: string): Promise<void> {
  const { error: orderItemsError } = await supabase
    .from("order_items")
    .delete()
    .eq("product_id", productId);
  if (orderItemsError) throw orderItemsError;

  const { error } = await supabase
    .from("products")
    .delete()
    .eq("id", productId);
  if (error) throw error;
  categoriesCache = null;
}

export async function listAllProducts(
  page = 1,
  pageSize = 8,
): Promise<{ products: Product[]; total: number }> {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const { data, error, count } = await supabase
    .from("products")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);
  if (error) throw error;
  return { products: (data || []) as Product[], total: count || 0 };
}

export async function listRecentOrders(limit = 10): Promise<Order[]> {
  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .neq("status", "awaiting_payment")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data || []) as Order[];
}

export async function deleteExpiredUnpaidOrders(
  olderThanMinutes = 10,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
  const { data: expired, error: lookupError } = await supabase
    .from("orders")
    .select("id, customer_telegram_id")
    .eq("status", "awaiting_payment")
    .lt("created_at", cutoff);
  if (lookupError) throw lookupError;

  for (const order of expired || []) {
    await deleteUnpaidOrder(order.id);
    const { error: sessionError } = await supabase
      .from("conversations")
      .update({ pending_order_id: null })
      .eq("chat_id", order.customer_telegram_id)
      .eq("pending_order_id", order.id);
    if (sessionError) throw sessionError;
  }
  return expired?.length || 0;
}

export async function listPaymentMethods(
  activeOnly = true,
): Promise<PaymentMethod[]> {
  let query = supabase
    .from("payment_methods")
    .select("*")
    .order("name", { ascending: true });
  if (activeOnly) query = query.eq("is_active", true);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []) as PaymentMethod[];
}

export async function createPaymentMethod(data: {
  name: string;
  account_number: string;
  account_name?: string | null;
  instructions?: string | null;
}): Promise<PaymentMethod> {
  const { data: method, error } = await supabase
    .from("payment_methods")
    .insert({ ...data, is_active: true })
    .select()
    .single();
  if (error) throw error;
  return method as PaymentMethod;
}

export async function updatePaymentMethod(
  id: string,
  updates: Partial<PaymentMethod>,
): Promise<PaymentMethod> {
  const { data, error } = await supabase
    .from("payment_methods")
    .update(updates)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data as PaymentMethod;
}

export async function deletePaymentMethod(id: string): Promise<void> {
  const { error } = await supabase
    .from("payment_methods")
    .update({ is_active: false })
    .eq("id", id);
  if (error) throw error;
}

export async function getStoreAddress(): Promise<StoreAddress | null> {
  const { data, error } = await supabase
    .from("store_addresses")
    .select("*")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data || null) as StoreAddress | null;
}

export async function saveStoreAddress(data: {
  address: string;
  description?: string | null;
  image_url?: string | null;
}): Promise<StoreAddress> {
  const existing = await getStoreAddress();
  const query = existing
    ? supabase.from("store_addresses").update(data).eq("id", existing.id)
    : supabase.from("store_addresses").insert(data);
  const { data: saved, error } = await query.select().single();
  if (error) throw error;
  return saved as StoreAddress;
}

export async function deleteStoreAddress(id: string): Promise<void> {
  const { error } = await supabase
    .from("store_addresses")
    .delete()
    .eq("id", id);
  if (error) throw error;
}

// ---- orders ----

export async function createOrderFromCart(
  customerTelegramId: number,
  customerName: string,
  cart: CartItem[],
  delivery?: {
    customerPhone?: string | null;
    deliveryLocation?: string | null;
    deliveryFee?: number;
    paymentMethod?: PaymentMethod;
  },
): Promise<Order> {
  const subtotal = cart.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0,
  );
  const deliveryFee = delivery?.deliveryFee || 0;
  const total = subtotal + deliveryFee;

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .insert({
      customer_telegram_id: customerTelegramId,
      customer_name: customerName,
      customer_phone: delivery?.customerPhone || null,
      delivery_location: delivery?.deliveryLocation || null,
      delivery_fee: deliveryFee,
      subtotal,
      total,
      status: "awaiting_payment",
      payment_method_id: delivery?.paymentMethod?.id || null,
      payment_method_name: delivery?.paymentMethod?.name || null,
      payment_account_number: delivery?.paymentMethod?.account_number || null,
      payment_account_name: delivery?.paymentMethod?.account_name || null,
    })
    .select()
    .single();
  if (orderError) throw orderError;

  const items = cart.map((item) => ({
    order_id: order.id,
    product_id: item.product_id,
    product_name: item.name,
    unit_price: item.price,
    quantity: item.quantity,
  }));

  const { error: itemsError } = await supabase
    .from("order_items")
    .insert(items);
  if (itemsError) throw itemsError;

  return order as Order;
}

export async function attachScreenshot(
  orderId: string,
  screenshotUrl: string,
): Promise<Order> {
  const { data, error } = await supabase
    .from("orders")
    .update({
      screenshot_url: screenshotUrl,
      status: "pending_verification",
      updated_at: new Date().toISOString(),
    })
    .eq("id", orderId)
    .select()
    .single();
  if (error) throw error;
  return data as Order;
}

export async function deleteUnpaidOrder(orderId: string): Promise<void> {
  const { data: order, error: orderLookupError } = await supabase
    .from("orders")
    .select("status")
    .eq("id", orderId)
    .maybeSingle();
  if (orderLookupError) throw orderLookupError;
  if (!order || order.status !== "awaiting_payment") return;

  const { error: orderItemsError } = await supabase
    .from("order_items")
    .delete()
    .eq("order_id", orderId);
  if (orderItemsError) throw orderItemsError;

  const { error } = await supabase
    .from("orders")
    .delete()
    .eq("id", orderId)
    .eq("status", "awaiting_payment");
  if (error) throw error;
}

export async function setOrderStatus(
  orderId: string,
  status: OrderStatus,
  rejectionReason?: string | null,
): Promise<Order> {
  const updates: any = { status, updated_at: new Date().toISOString() };
  if (rejectionReason !== undefined) {
    updates.rejection_reason = rejectionReason || null;
  }
  const { data, error } = await supabase
    .from("orders")
    .update(updates)
    .eq("id", orderId)
    .select()
    .single();
  if (error) throw error;
  return data as Order;
}

export async function getCustomerOrders(
  customerTelegramId: number,
  limit = 10,
): Promise<Order[]> {
  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .eq("customer_telegram_id", customerTelegramId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data as Order[];
}

export async function getOrder(orderId: string): Promise<Order> {
  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .single();
  if (error) throw error;
  return data as Order;
}

export async function getPendingVerificationOrders(
  olderThanMinutes: number,
): Promise<Order[]> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60000).toISOString();
  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .eq("status", "pending_verification")
    .lt("created_at", cutoff);
  if (error) throw error;
  return data as Order[];
}

export async function incrementReminder(
  orderId: string,
  newCount: number,
): Promise<void> {
  const { error } = await supabase
    .from("orders")
    .update({ reminder_count: newCount })
    .eq("id", orderId);
  if (error) throw error;
}

// ---- sessions ----

export async function loadSession(chatId: number): Promise<Session> {
  const { data, error } = await supabase
    .from("conversations")
    .select("*")
    .eq("chat_id", chatId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    return {
      language: "en",
      history: [],
      cart: [],
      pendingOrderId: null,
      customerPhone: null,
      deliveryLocation: null,
      deliveryFee: 0,
      pendingStep: null,
    };
  }
  return {
    language: data.language || "en",
    history: data.history || [],
    cart: data.cart || [],
    pendingOrderId: data.pending_order_id || null,
    customerPhone: data.customer_phone || null,
    deliveryLocation: data.delivery_location || null,
    deliveryFee: Number(data.delivery_fee) || 0,
    pendingStep: (data.pending_step as any) || null,
  };
}

export async function saveSession(
  chatId: number,
  session: Session,
): Promise<void> {
  const { error } = await supabase.from("conversations").upsert({
    chat_id: chatId,
    language: session.language,
    history: session.history,
    cart: session.cart,
    pending_order_id: session.pendingOrderId,
    customer_phone: session.customerPhone || null,
    delivery_location: session.deliveryLocation || null,
    delivery_fee: session.deliveryFee || 0,
    pending_step: session.pendingStep || null,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}
