"use client";

import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  Timestamp,
} from "firebase/firestore";
import { firestore } from "./firebase";
import { db } from "./db";
import type { CashClosing, CashMovement, CustomerDebt, DebtPayment, Expense, Product, Purchase, Sale, ShopProfile, StockLoss, Supplier, SupplierPayment } from "./models";

type SyncCounts = {
  products: number;
  sales: number;
  expenses: number;
  debts: number;
  debtPayments: number;
  suppliers: number;
  stockLosses: number;
  purchases: number;
  supplierPayments: number;
  cashMovements: number;
  cashClosings: number;
};

function requireFirestore() {
  if (!firestore) throw new Error("Firebase Firestore is not configured");
  return firestore;
}

function accountUid(ownerUid: string) { return ownerUid.split("::", 1)[0]; }
function shopIdFromOwner(ownerUid: string) { return ownerUid.split("::")[1]; }
function shopProfileRef(ownerUid: string) {
  const firestoreDb = requireFirestore();
  const shopId = shopIdFromOwner(ownerUid);
  return shopId ? doc(firestoreDb, "users", accountUid(ownerUid), "shops", shopId) : doc(firestoreDb, "users", ownerUid);
}

function hasPremiumAccess(shop: ShopProfile | null) {
  return shop?.estActif === true &&
    (!shop.subscriptionExpiresAt || new Date(shop.subscriptionExpiresAt).getTime() > Date.now());
}

function userCollection<T extends { id: string }>(ownerUid: string, name: string) {
  const shopId = shopIdFromOwner(ownerUid);
  return shopId
    ? collection(requireFirestore(), "users", accountUid(ownerUid), "shops", shopId, name)
    : collection(requireFirestore(), "users", ownerUid, name);
}

function dataDoc(ownerUid: string, name: string, id: string) {
  const shopId = shopIdFromOwner(ownerUid);
  return shopId
    ? doc(requireFirestore(), "users", accountUid(ownerUid), "shops", shopId, name, id)
    : doc(requireFirestore(), "users", ownerUid, name, id);
}

async function mergeRemote<T extends { id: string; ownerUid: string; synced: boolean; isDeleted?: boolean }>(
  ownerUid: string,
  name: string,
  table: {
    get: (key: string) => Promise<T | undefined>;
    put: (value: T) => Promise<unknown>;
    delete: (key: string) => Promise<unknown>;
  },
) {
  const snapshot = await getDocs(userCollection<T>(ownerUid, name));
  for (const remoteDoc of snapshot.docs) {
    const remote = { ...remoteDoc.data(), id: remoteDoc.id, ownerUid, synced: true } as T;
    if (remote.isDeleted) {
      await table.delete(remote.id);
      continue;
    }
    const local = await table.get(remote.id);
    if (!local || local.synced) await table.put(remote);
  }
}

export async function saveShopProfile(
  ownerUid: string,
  profile: Pick<ShopProfile, "name" | "currency"> & Partial<Pick<ShopProfile, "phone">>,
) {
  const shopRef = shopProfileRef(ownerUid);
  const current = await getDoc(shopRef);
  await setDoc(shopRef, {
    name: profile.name,
    currency: profile.currency,
    ...(profile.phone ? { phone: profile.phone } : {}),
    ...(current.exists() ? {} : {
      uid: accountUid(ownerUid),
      estActif: false,
      createdAt: new Date().toISOString(),
    }),
  }, { merge: true });
}

export async function loadCloudData(ownerUid: string) {
  const firestoreDb = requireFirestore();
  const shopSnapshot = await getDoc(shopProfileRef(ownerUid));
  const shopData = shopSnapshot.exists() ? shopSnapshot.data() : null;
  let accountData: Record<string, unknown> | null = null;
  if (shopIdFromOwner(ownerUid)) {
    const accountSnapshot = await getDoc(doc(firestoreDb, "users", accountUid(ownerUid)));
    accountData = accountSnapshot.exists() ? accountSnapshot.data() : null;
  }
  const entitlementData = shopData?.estActif === true ? shopData : accountData ?? shopData;
  const shop: ShopProfile | null = shopData
    ? {
        ownerUid,
        name: typeof shopData.name === "string" ? shopData.name : "Ma boutique",
        currency: typeof shopData.currency === "string" ? shopData.currency : "XOF",
        ...(typeof shopData.phone === "string" ? { phone: shopData.phone } : {}),
        ...(typeof entitlementData?.estActif === "boolean" ? { estActif: entitlementData.estActif } : {}),
        subscriptionStatus: shopData.subscriptionStatus === "PREMIUM" ? "PREMIUM" : "FREE",
        subscriptionExpiresAt: entitlementData?.subscriptionExpiresAt instanceof Timestamp
          ? entitlementData.subscriptionExpiresAt.toDate().toISOString()
          : typeof entitlementData?.subscriptionExpiresAt === "string"
            ? entitlementData.subscriptionExpiresAt
            : null,
      }
    : null;

  const dataLoads = [
    mergeRemote<Product>(ownerUid, "products", db.products),
    mergeRemote<Sale>(ownerUid, "sales", db.sales),
    mergeRemote<Expense>(ownerUid, "expenses", db.expenses),
    mergeRemote<CustomerDebt>(ownerUid, "debts", db.debts),
    mergeRemote<DebtPayment>(ownerUid, "debtPayments", db.debtPayments),
  ];
  if (hasPremiumAccess(shop)) {
    dataLoads.push(
      mergeRemote<Supplier>(ownerUid, "suppliers", db.suppliers),
      mergeRemote<StockLoss>(ownerUid, "stockLosses", db.stockLosses),
      mergeRemote<Purchase>(ownerUid, "purchases", db.purchases),
      mergeRemote<SupplierPayment>(ownerUid, "supplierPayments", db.supplierPayments),
    );
  }
  dataLoads.push(
    mergeRemote<CashMovement>(ownerUid, "cashMovements", db.cashMovements),
    mergeRemote<CashClosing>(ownerUid, "cashClosings", db.cashClosings),
  );
  await Promise.all(dataLoads);
  return { shop };
}

export async function loadCloudShops(ownerUid: string): Promise<ShopProfile[]> {
  const snapshot = await getDocs(collection(requireFirestore(), "users", accountUid(ownerUid), "shops"));
  return snapshot.docs.map((item) => {
    const data = item.data();
    const key = `${accountUid(ownerUid)}::${item.id}`;
    return {
      ownerUid: key,
      shopId: item.id,
      name: typeof data.name === "string" ? data.name : "Ma boutique",
      currency: typeof data.currency === "string" ? data.currency : "XOF",
      phone: typeof data.phone === "string" ? data.phone : undefined,
      subscriptionStatus: data.subscriptionStatus === "PREMIUM" ? "PREMIUM" : "FREE",
      estActif: typeof data.estActif === "boolean" ? data.estActif : undefined,
      subscriptionExpiresAt: typeof data.subscriptionExpiresAt === "string" ? data.subscriptionExpiresAt : null,
    };
  });
}

export async function syncPending(ownerUid: string, includePremiumData: boolean): Promise<SyncCounts> {
  requireFirestore();
  const [products, sales, expenses, debts, debtPayments, suppliers, stockLosses, purchases, supplierPayments, cashMovements, cashClosings] = await Promise.all([
    db.products.where("ownerUid").equals(ownerUid).toArray(),
    db.sales.where("ownerUid").equals(ownerUid).toArray(),
    db.expenses.where("ownerUid").equals(ownerUid).toArray(),
    db.debts.where("ownerUid").equals(ownerUid).toArray(),
    db.debtPayments.where("ownerUid").equals(ownerUid).toArray(),
    includePremiumData ? db.suppliers.where("ownerUid").equals(ownerUid).toArray() : Promise.resolve([]),
    includePremiumData ? db.stockLosses.where("ownerUid").equals(ownerUid).toArray() : Promise.resolve([]),
    includePremiumData ? db.purchases.where("ownerUid").equals(ownerUid).toArray() : Promise.resolve([]),
    includePremiumData ? db.supplierPayments.where("ownerUid").equals(ownerUid).toArray() : Promise.resolve([]),
    db.cashMovements.where("ownerUid").equals(ownerUid).toArray(),
    db.cashClosings.where("ownerUid").equals(ownerUid).toArray(),
  ]);
  const counts = {
    products: products.length,
    sales: sales.length,
    expenses: expenses.length,
    debts: debts.length,
    debtPayments: debtPayments.length,
    suppliers: suppliers.length,
    stockLosses: stockLosses.length,
    purchases: purchases.length,
    supplierPayments: supplierPayments.length,
    cashMovements: cashMovements.length,
    cashClosings: cashClosings.length,
  };

  for (const product of products) {
    await setDoc(dataDoc(ownerUid, "products", product.id), product);
    await db.products.update(product.id, { synced: true });
  }
  for (const sale of sales) {
    await setDoc(dataDoc(ownerUid, "sales", sale.id), sale);
    await db.sales.update(sale.id, { synced: true });
  }
  for (const expense of expenses) {
    await setDoc(dataDoc(ownerUid, "expenses", expense.id), expense);
    await db.expenses.update(expense.id, { synced: true });
  }
  for (const debt of debts) {
    await setDoc(dataDoc(ownerUid, "debts", debt.id), debt);
    await db.debts.update(debt.id, { synced: true });
  }
  for (const payment of debtPayments) {
    await setDoc(dataDoc(ownerUid, "debtPayments", payment.id), payment);
    await db.debtPayments.update(payment.id, { synced: true });
  }
  for (const supplier of suppliers) {
    await setDoc(dataDoc(ownerUid, "suppliers", supplier.id), supplier);
    await db.suppliers.update(supplier.id, { synced: true });
  }
  for (const loss of stockLosses) {
    await setDoc(dataDoc(ownerUid, "stockLosses", loss.id), loss);
    await db.stockLosses.update(loss.id, { synced: true });
  }
  for (const purchase of purchases) {
    await setDoc(dataDoc(ownerUid, "purchases", purchase.id), purchase);
    await db.purchases.update(purchase.id, { synced: true });
  }
  for (const payment of supplierPayments) {
    await setDoc(dataDoc(ownerUid, "supplierPayments", payment.id), payment);
    await db.supplierPayments.update(payment.id, { synced: true });
  }
  for (const movement of cashMovements) {
    await setDoc(dataDoc(ownerUid, "cashMovements", movement.id), movement);
    await db.cashMovements.update(movement.id, { synced: true });
  }
  for (const closing of cashClosings) {
    await setDoc(dataDoc(ownerUid, "cashClosings", closing.id), closing);
    await db.cashClosings.update(closing.id, { synced: true });
  }
  return counts;
}
