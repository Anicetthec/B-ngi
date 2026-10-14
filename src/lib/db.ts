import Dexie, { type EntityTable } from "dexie";
import type { CashClosing, CashMovement, CustomerDebt, DebtPayment, Expense, Product, Purchase, Sale, StockLoss, Supplier, SupplierPayment } from "./models";

class ZamboDatabase extends Dexie {
  products!: EntityTable<Product, "id">;
  sales!: EntityTable<Sale, "id">;
  expenses!: EntityTable<Expense, "id">;
  debts!: EntityTable<CustomerDebt, "id">;
  debtPayments!: EntityTable<DebtPayment, "id">;
  suppliers!: EntityTable<Supplier, "id">;
  stockLosses!: EntityTable<StockLoss, "id">;
  purchases!: EntityTable<Purchase, "id">;
  supplierPayments!: EntityTable<SupplierPayment, "id">;
  cashMovements!: EntityTable<CashMovement, "id">;
  cashClosings!: EntityTable<CashClosing, "id">;

  constructor() {
    super("zambo-stock");
    this.version(1).stores({
      products: "id, ownerUid, name, updatedAt, synced",
      sales: "id, ownerUid, createdAt, synced",
      expenses: "id, ownerUid, createdAt, synced",
      debts: "id, ownerUid, customerName, createdAt, synced",
    });
    this.version(2).stores({
      products: "id, ownerUid, name, updatedAt, synced",
      sales: "id, ownerUid, createdAt, synced",
      expenses: "id, ownerUid, createdAt, synced",
      debts: "id, ownerUid, customerName, createdAt, synced",
      debtPayments: "id, ownerUid, debtId, createdAt, synced",
    });
    this.version(3).stores({
      products: "id, ownerUid, name, updatedAt, synced",
      sales: "id, ownerUid, createdAt, synced",
      expenses: "id, ownerUid, createdAt, synced",
      debts: "id, ownerUid, customerName, createdAt, synced, dueDate",
      debtPayments: "id, ownerUid, debtId, createdAt, synced",
      suppliers: "id, ownerUid, name, synced",
      stockLosses: "id, ownerUid, productId, createdAt, synced",
    });
    this.version(4).stores({
      products: "id, ownerUid, name, updatedAt, synced",
      sales: "id, ownerUid, createdAt, synced",
      expenses: "id, ownerUid, createdAt, synced",
      debts: "id, ownerUid, customerName, createdAt, synced, dueDate, saleId",
      debtPayments: "id, ownerUid, debtId, createdAt, synced",
      suppliers: "id, ownerUid, name, synced",
      stockLosses: "id, ownerUid, productId, createdAt, synced",
      purchases: "id, ownerUid, productId, supplierId, createdAt, synced",
      supplierPayments: "id, ownerUid, purchaseId, createdAt, synced",
      cashMovements: "id, ownerUid, kind, paymentMethod, createdAt, synced",
      cashClosings: "id, ownerUid, date, synced",
    });
  }
}

export const db = new ZamboDatabase();
