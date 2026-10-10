import Dexie, { type EntityTable } from "dexie";
import type { CustomerDebt, DebtPayment, Expense, Product, Sale } from "./models";

class ZamboDatabase extends Dexie {
  products!: EntityTable<Product, "id">;
  sales!: EntityTable<Sale, "id">;
  expenses!: EntityTable<Expense, "id">;
  debts!: EntityTable<CustomerDebt, "id">;
  debtPayments!: EntityTable<DebtPayment, "id">;

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
  }
}

export const db = new ZamboDatabase();
