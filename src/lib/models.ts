export type SubscriptionStatus = "FREE" | "PREMIUM";
export type PaymentMethod = "cash" | "orange_money" | "moov_money" | "credit";
export type Section = "dashboard" | "products" | "sales" | "expenses" | "debts" | "purchases" | "cash" | "reports" | "suppliers" | "losses" | "settings";

export interface Product {
  id: string;
  ownerUid: string;
  name: string;
  category: string;
  costPrice: number;
  sellingPrice: number;
  stock: number;
  lowStockThreshold: number;
  supplierId?: string;
  supplierName?: string;
  updatedAt: string;
  synced: boolean;
  isDeleted?: boolean;
}

export interface SaleItem {
  id: string;
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  costPrice: number;
}

export interface Sale {
  id: string;
  ownerUid: string;
  total: number;
  createdAt: string;
  items: SaleItem[];
  paymentMethod?: PaymentMethod;
  amountPaid?: number;
  customerName?: string;
  customerPhone?: string;
  synced: boolean;
  isDeleted?: boolean;
}

export interface Expense {
  id: string;
  ownerUid: string;
  label: string;
  amount: number;
  paymentMethod?: Exclude<PaymentMethod, "credit">;
  createdAt: string;
  synced: boolean;
  isDeleted?: boolean;
}

export interface CustomerDebt {
  id: string;
  ownerUid: string;
  customerName: string;
  phone: string;
  amount: number;
  note: string;
  saleId?: string;
  dueDate?: string;
  isPaid: boolean;
  createdAt: string;
  synced: boolean;
  isDeleted?: boolean;
}

export interface Supplier {
  id: string;
  ownerUid: string;
  name: string;
  phone: string;
  note: string;
  synced: boolean;
  isDeleted?: boolean;
}

export interface StockLoss {
  id: string;
  ownerUid: string;
  productId: string;
  productName: string;
  quantity: number;
  unitCost: number;
  reason: string;
  createdAt: string;
  synced: boolean;
  isDeleted?: boolean;
}

export interface DebtPayment {
  id: string;
  ownerUid: string;
  debtId: string;
  amount: number;
  paymentMethod?: Exclude<PaymentMethod, "credit">;
  createdAt: string;
  synced: boolean;
  isDeleted?: boolean;
}

export interface Purchase {
  id: string;
  ownerUid: string;
  productId: string;
  productName: string;
  supplierId?: string;
  supplierName: string;
  quantity: number;
  unitCost: number;
  total: number;
  amountPaid: number;
  paymentMethod: Exclude<PaymentMethod, "credit">;
  createdAt: string;
  synced: boolean;
  isDeleted?: boolean;
}

export interface SupplierPayment {
  id: string;
  ownerUid: string;
  purchaseId: string;
  amount: number;
  paymentMethod: Exclude<PaymentMethod, "credit">;
  createdAt: string;
  synced: boolean;
  isDeleted?: boolean;
}

export interface CashMovement {
  id: string;
  ownerUid: string;
  kind: "deposit" | "withdrawal";
  amount: number;
  paymentMethod: Exclude<PaymentMethod, "credit">;
  note: string;
  createdAt: string;
  synced: boolean;
  isDeleted?: boolean;
}

export interface CashClosing {
  id: string;
  ownerUid: string;
  date: string;
  openingCash: number;
  countedCash: number;
  expectedCash: number;
  note: string;
  closedAt: string;
  synced: boolean;
}

export interface ShopProfile {
  ownerUid: string;
  shopId?: string;
  name: string;
  currency: string;
  phone?: string;
  estActif?: boolean;
  subscriptionStatus: SubscriptionStatus;
  subscriptionExpiresAt?: string | null;
}
