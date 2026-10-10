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
import type { CustomerDebt, DebtPayment, Expense, Product, Sale, ShopProfile } from "./models";

type SyncCounts = {
  products: number;
  sales: number;
  expenses: number;
  debts: number;
  debtPayments: number;
};

function requireFirestore() {
  if (!firestore) throw new Error("Firebase Firestore is not configured");
  return firestore;
}

function hasPremiumAccess(shop: ShopProfile | null) {
  return shop?.estActif === true &&
    (!shop.subscriptionExpiresAt || new Date(shop.subscriptionExpiresAt).getTime() > Date.now());
}

function userCollection<T extends { id: string }>(ownerUid: string, name: string) {
  return collection(requireFirestore(), "users", ownerUid, name);
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
  const shopRef = doc(requireFirestore(), "users", ownerUid);
  const current = await getDoc(shopRef);
  await setDoc(shopRef, {
    name: profile.name,
    currency: profile.currency,
    ...(profile.phone ? { phone: profile.phone } : {}),
    ...(current.exists() ? {} : {
      uid: ownerUid,
      estActif: false,
      createdAt: new Date().toISOString(),
    }),
  }, { merge: true });
}

export async function loadCloudData(ownerUid: string) {
  const firestoreDb = requireFirestore();
  const shopSnapshot = await getDoc(doc(firestoreDb, "users", ownerUid));
  const shopData = shopSnapshot.exists() ? shopSnapshot.data() : null;
  const shop: ShopProfile | null = shopData
    ? {
        ownerUid,
        name: typeof shopData.name === "string" ? shopData.name : "Ma boutique",
        currency: typeof shopData.currency === "string" ? shopData.currency : "XOF",
        ...(typeof shopData.phone === "string" ? { phone: shopData.phone } : {}),
        ...(typeof shopData.estActif === "boolean" ? { estActif: shopData.estActif } : {}),
        subscriptionStatus: shopData.subscriptionStatus === "PREMIUM" ? "PREMIUM" : "FREE",
        subscriptionExpiresAt: shopData.subscriptionExpiresAt instanceof Timestamp
          ? shopData.subscriptionExpiresAt.toDate().toISOString()
          : typeof shopData.subscriptionExpiresAt === "string"
            ? shopData.subscriptionExpiresAt
            : null,
      }
    : null;

  const dataLoads = [
    mergeRemote<Product>(ownerUid, "products", db.products),
    mergeRemote<Sale>(ownerUid, "sales", db.sales),
    mergeRemote<Expense>(ownerUid, "expenses", db.expenses),
  ];
  if (hasPremiumAccess(shop)) {
    dataLoads.push(
      mergeRemote<CustomerDebt>(ownerUid, "debts", db.debts),
      mergeRemote<DebtPayment>(ownerUid, "debtPayments", db.debtPayments),
    );
  }
  await Promise.all(dataLoads);
  return { shop };
}

export async function syncPending(ownerUid: string, includePremiumData: boolean): Promise<SyncCounts> {
  const firestoreDb = requireFirestore();
  const [products, sales, expenses, debts, debtPayments] = await Promise.all([
    db.products.where({ ownerUid, synced: false }).toArray(),
    db.sales.where({ ownerUid, synced: false }).toArray(),
    db.expenses.where({ ownerUid, synced: false }).toArray(),
    includePremiumData ? db.debts.where({ ownerUid, synced: false }).toArray() : Promise.resolve([]),
    includePremiumData ? db.debtPayments.where({ ownerUid, synced: false }).toArray() : Promise.resolve([]),
  ]);
  const counts = {
    products: products.length,
    sales: sales.length,
    expenses: expenses.length,
    debts: debts.length,
    debtPayments: debtPayments.length,
  };

  for (const product of products) {
    await setDoc(doc(firestoreDb, "users", ownerUid, "products", product.id), product);
    await db.products.update(product.id, { synced: true });
  }
  for (const sale of sales) {
    await setDoc(doc(firestoreDb, "users", ownerUid, "sales", sale.id), sale);
    await db.sales.update(sale.id, { synced: true });
  }
  for (const expense of expenses) {
    await setDoc(doc(firestoreDb, "users", ownerUid, "expenses", expense.id), expense);
    await db.expenses.update(expense.id, { synced: true });
  }
  for (const debt of debts) {
    await setDoc(doc(firestoreDb, "users", ownerUid, "debts", debt.id), debt);
    await db.debts.update(debt.id, { synced: true });
  }
  for (const payment of debtPayments) {
    await setDoc(doc(firestoreDb, "users", ownerUid, "debtPayments", payment.id), payment);
    await db.debtPayments.update(payment.id, { synced: true });
  }
  return counts;
}
