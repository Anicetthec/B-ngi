export type SubscriptionStatus = "FREE" | "PREMIUM";
export type Section = "dashboard" | "products" | "sales" | "expenses" | "debts" | "reports" | "settings";

export interface Product {
  id: string;
  ownerUid: string;
  name: string;
  category: string;
  costPrice: number;
  sellingPrice: number;
  stock: number;
  lowStockThreshold: number;
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
  synced: boolean;
  isDeleted?: boolean;
}

export interface Expense {
  id: string;
  ownerUid: string;
  label: string;
  amount: number;
  createdAt: string;
  synced: boolean;
}

export interface CustomerDebt {
  id: string;
  ownerUid: string;
  customerName: string;
  phone: string;
  amount: number;
  note: string;
  isPaid: boolean;
  createdAt: string;
  synced: boolean;
  isDeleted?: boolean;
}

export interface DebtPayment {
  id: string;
  ownerUid: string;
  debtId: string;
  amount: number;
  createdAt: string;
  synced: boolean;
  isDeleted?: boolean;
}

export interface ShopProfile {
  ownerUid: string;
  name: string;
  currency: string;
  phone?: string;
  estActif?: boolean;
  subscriptionStatus: SubscriptionStatus;
  subscriptionExpiresAt?: string | null;
}
