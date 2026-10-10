"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  onAuthStateChanged,
  signInAnonymously,
  signOut,
  type User,
} from "firebase/auth";
import { auth, firebaseConfigured } from "@/lib/firebase";
import { db } from "@/lib/db";
import type { CustomerDebt, DebtPayment, Expense, Product, Sale, Section, ShopProfile } from "@/lib/models";
import { loadCloudData, saveShopProfile, syncPending } from "@/lib/sync";

type Toast = { kind: "success" | "error"; text: string } | null;
type CatalogDraft = {
  name: string;
  category: string;
  costPrice: string;
  sellingPrice: string;
  stock: string;
  lowStockThreshold: string;
};

const CURRENCY = "XOF";
const BURKINA_PREFIX = "+226";
const navItems: { id: Section; label: string; icon: string; premium?: boolean }[] = [
  { id: "dashboard", label: "Accueil", icon: "◫" },
  { id: "products", label: "Produits & stock", icon: "▤" },
  { id: "sales", label: "Vendre", icon: "↗" },
  { id: "expenses", label: "Dépenses", icon: "↘" },
  { id: "debts", label: "Crédits clients", icon: "◷", premium: true },
  { id: "reports", label: "Bilans", icon: "▥", premium: true },
];

function money(amount: number, currency = CURRENCY) {
  const label = currency === "XOF" || currency === "XAF" ? "FCFA" : currency;
  return `${new Intl.NumberFormat("fr-FR").format(amount)} ${label}`;
}

function dateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isOnDay(value: string, day: string) {
  return dateInputValue(new Date(value)) === day;
}

function dayLabel(date: string) {
  return new Date(date).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}

function receiptText(sale: Sale, shopName: string, currency: string) {
  const itemLines = sale.items.map((item) => `${item.quantity} × ${item.productName} — ${money(item.unitPrice * item.quantity, currency)}`);
  return [
    shopName || "Ma boutique",
    `Reçu de vente #${sale.id.slice(0, 7).toUpperCase()}`,
    dayLabel(sale.createdAt),
    ...itemLines,
    `TOTAL : ${money(sale.total, currency)}`,
    "Merci pour votre achat !",
  ].join("\n");
}

function newId() {
  return crypto.randomUUID();
}

function normalizeBurkinaPhone(value: string) {
  const compact = value.trim().replace(/[\s().-]/g, "");
  if (/^\d{8}$/.test(compact)) return `${BURKINA_PREFIX}${compact}`;
  if (/^226\d{8}$/.test(compact)) return `+${compact}`;
  if (/^00226\d{8}$/.test(compact)) return `+${compact.slice(2)}`;
  if (/^\+\d{10,15}$/.test(compact)) return compact;
  return null;
}

function whatsappActivationUrl(uid: string, shopName: string, phone: string) {
  const message = `Bonjour, je souhaite activer mon abonnement mensuel Bĩngi. Mon ID utilisateur Firebase est : ${uid}. Boutique : ${shopName || "Ma boutique"}. Numéro de téléphone : ${phone}.`;
  return `https://wa.me/message/SQXBCLHS6SBXN1?text=${encodeURIComponent(message)}`;
}

function isActivePremium(shop: ShopProfile | null) {
  if (!shop || shop.estActif !== true) return false;
  return !shop.subscriptionExpiresAt || new Date(shop.subscriptionExpiresAt).getTime() > Date.now();
}

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [ownerUid, setOwnerUid] = useState("");
  const [phone, setPhone] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  const [section, setSection] = useState<Section>("dashboard");
  const [shopName, setShopName] = useState("");
  const [currency, setCurrency] = useState(CURRENCY);
  const [shop, setShop] = useState<ShopProfile | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [debts, setDebts] = useState<CustomerDebt[]>([]);
  const [debtPayments, setDebtPayments] = useState<DebtPayment[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("Hors ligne prêt");
  const [toast, setToast] = useState<Toast>(null);
  const [modal, setModal] = useState<"product" | "sale" | "expense" | "debt" | "debt-payment" | "debt-payment-edit" | "receipt" | "premium" | "cloud-sync" | null>(null);
  const [selectedReceipt, setSelectedReceipt] = useState<Sale | null>(null);
  const [selectedDebt, setSelectedDebt] = useState<CustomerDebt | null>(null);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [editingSale, setEditingSale] = useState<Sale | null>(null);
  const [editingDebt, setEditingDebt] = useState<CustomerDebt | null>(null);
  const [editingDebtPayment, setEditingDebtPayment] = useState<DebtPayment | null>(null);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const migratingRef = useRef(false);
  const [draft, setDraft] = useState<CatalogDraft>({
    name: "",
    category: "",
    costPrice: "",
    sellingPrice: "",
    stock: "",
    lowStockThreshold: "5",
  });
  const [saleProductId, setSaleProductId] = useState("");
  const [saleQuantity, setSaleQuantity] = useState("1");
  const [expenseLabel, setExpenseLabel] = useState("");
  const [expenseAmount, setExpenseAmount] = useState("");
  const [debtName, setDebtName] = useState("");
  const [debtPhone, setDebtPhone] = useState("");
  const [debtAmount, setDebtAmount] = useState("");
  const [debtNote, setDebtNote] = useState("");
  const [debtPaymentAmount, setDebtPaymentAmount] = useState("");
  const [reportDate, setReportDate] = useState(() => dateInputValue(new Date()));
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const premium = isActivePremium(shop);
  const lowStock = useMemo(
    () => products.filter((product) => product.stock <= product.lowStockThreshold),
    [products],
  );
  const todaySales = useMemo(() => {
    const today = new Date().toDateString();
    return sales.filter((sale) => new Date(sale.createdAt).toDateString() === today);
  }, [sales]);
  const todayRevenue = todaySales.reduce((sum, sale) => sum + sale.total, 0);
  const todayProfit = todaySales.reduce(
    (sum, sale) => sum + sale.items.reduce((profit, item) => profit + (item.unitPrice - item.costPrice) * item.quantity, 0),
    0,
  );
  const paidByDebt = useMemo(() => debtPayments.reduce((totals, payment) => {
    totals.set(payment.debtId, (totals.get(payment.debtId) ?? 0) + payment.amount);
    return totals;
  }, new Map<string, number>()), [debtPayments]);
  const remainingForDebt = useCallback((debt: CustomerDebt) => {
    const paid = paidByDebt.get(debt.id) ?? 0;
    return debt.isPaid && paid === 0 ? 0 : Math.max(0, debt.amount - paid);
  }, [paidByDebt]);
  const filteredProducts = products.filter((product) =>
    `${product.name} ${product.category}`.toLowerCase().includes(search.toLowerCase()),
  );

  const notify = useCallback((kind: "success" | "error", text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 3800);
  }, []);

  const refreshLocal = useCallback(async (uid = ownerUid) => {
    if (!uid) return;
    const [nextProducts, nextSales, nextExpenses, nextDebtsRaw, nextDebtPayments] = await Promise.all([
      db.products.where("ownerUid").equals(uid).toArray(),
      db.sales.where("ownerUid").equals(uid).toArray(),
      db.expenses.where("ownerUid").equals(uid).toArray(),
      db.debts.where("ownerUid").equals(uid).toArray(),
      db.debtPayments.where("ownerUid").equals(uid).toArray(),
    ]);
    const visibleProducts = nextProducts.filter((item) => !item.isDeleted);
    const visibleSales = nextSales.filter((item) => !item.isDeleted);
    const visibleDebts = nextDebtsRaw.filter((item) => !item.isDeleted);
    const visiblePayments = nextDebtPayments.filter((item) => !item.isDeleted);
    visibleProducts.sort((a, b) => a.name.localeCompare(b.name));
    visibleSales.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    nextExpenses.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    visibleDebts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    visiblePayments.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    setProducts(visibleProducts);
    setSales(visibleSales);
    setExpenses(nextExpenses);
    setDebts(visibleDebts);
    setDebtPayments(visiblePayments);
  }, [ownerUid]);

  const synchronize = useCallback(async (uid = ownerUid) => {
    if (!uid || !user || !navigator.onLine || migratingRef.current) return;
    setSyncing(true);
    try {
      const profilePendingKey = `zambo-shop-pending:${uid}`;
      if (localStorage.getItem(profilePendingKey) === "true") {
        await saveShopProfile(uid, {
          name: localStorage.getItem(`zambo-shop-name:${uid}`) || shopName || "Ma boutique",
          currency: localStorage.getItem(`zambo-currency:${uid}`) || currency || CURRENCY,
          phone: localStorage.getItem(`zambo-shop-phone:${uid}`) || undefined,
        });
        localStorage.removeItem(profilePendingKey);
      }
      let initialCloud = await loadCloudData(uid);
      if (!initialCloud.shop) {
        await saveShopProfile(uid, {
          name: localStorage.getItem(`zambo-shop-name:${uid}`) || shopName || "Ma boutique",
          currency: localStorage.getItem(`zambo-currency:${uid}`) || currency || CURRENCY,
          phone: localStorage.getItem(`zambo-shop-phone:${uid}`) || undefined,
        });
        initialCloud = await loadCloudData(uid);
      }
      if (initialCloud.shop) {
        setShop(initialCloud.shop);
        setShopName(initialCloud.shop.name);
        setCurrency(initialCloud.shop.currency);
      }
      const counts = await syncPending(uid, isActivePremium(initialCloud.shop));
      const cloudShop = await loadCloudData(uid);
      if (cloudShop.shop) {
        const savedShop = cloudShop.shop;
        setShop(savedShop);
        setShopName(savedShop.name);
        setCurrency(savedShop.currency);
      }
      await refreshLocal(uid);
      setSyncMessage("Synchronisé");
      if (Object.values(counts).some((count) => count > 0)) notify("success", "Vos données hors ligne sont synchronisées.");
    } catch (error) {
      console.error("Firestore sync failed", error);
      setSyncMessage("Synchronisation en attente");
      notify("error", "La synchronisation a échoué. Les données restent enregistrées sur cet appareil.");
    } finally {
      setSyncing(false);
    }
  }, [currency, notify, ownerUid, refreshLocal, shopName, user]);

  useEffect(() => {
    let cancelled = false;
    let localUid = localStorage.getItem("zambo-local-owner");
    if (!localUid) {
      localUid = `local-${newId()}`;
      localStorage.setItem("zambo-local-owner", localUid);
    }
    const localName = localStorage.getItem(`zambo-shop-name:${localUid}`) || "Ma boutique";
    const localCurrency = localStorage.getItem(`zambo-currency:${localUid}`) || CURRENCY;
    setOwnerUid(localUid);
    setShop({ ownerUid: localUid, name: localName, currency: localCurrency, subscriptionStatus: "FREE" });
    setShopName(localName);
    setCurrency(localCurrency);

    if (!auth) return () => { cancelled = true; };
    return onAuthStateChanged(auth, async (nextUser) => {
      if (cancelled) return;
      setUser(nextUser);
      if (!nextUser) {
        setShop((current) => current ? { ...current, subscriptionStatus: "FREE", subscriptionExpiresAt: null } : current);
        return;
      }
      setOwnerUid(nextUser.uid);
      if (migratingRef.current) return;
      setLoading(true);
      try {
        const cloudShop = await loadCloudData(nextUser.uid);
        if (cloudShop.shop) {
          const savedShop = cloudShop.shop;
          setShop(savedShop);
          setShopName(savedShop.name);
          setCurrency(savedShop.currency);
          localStorage.setItem(`zambo-shop-name:${nextUser.uid}`, savedShop.name);
          localStorage.setItem(`zambo-currency:${nextUser.uid}`, savedShop.currency);
        } else {
          const savedName = localStorage.getItem(`zambo-shop-name:${nextUser.uid}`) || "Ma boutique";
          const savedCurrency = localStorage.getItem(`zambo-currency:${nextUser.uid}`) || CURRENCY;
          setShop({ ownerUid: nextUser.uid, name: savedName, currency: savedCurrency, subscriptionStatus: "FREE" });
          setShopName(savedName);
          setCurrency(savedCurrency);
          localStorage.setItem(`zambo-shop-pending:${nextUser.uid}`, "true");
        }
        setSyncMessage("Synchronisé");
      } catch (error) {
        console.error("Could not load Firebase Firestore data", error);
        setSyncMessage("Données locales disponibles");
        notify("error", "Impossible de joindre Firestore. Les données locales restent accessibles.");
      } finally {
        if (!cancelled) {
          await refreshLocal(nextUser.uid);
          setLoading(false);
        }
      }
    });
  }, [notify, refreshLocal]);

  useEffect(() => {
    if (ownerUid) void refreshLocal(ownerUid);
  }, [ownerUid, refreshLocal]);

  useEffect(() => {
    if (ownerUid) setLastBackupAt(localStorage.getItem(`zambo-last-backup:${ownerUid}`));
  }, [ownerUid]);

  useEffect(() => {
    if (user && ownerUid === user.uid) void synchronize(user.uid);
  }, [ownerUid, synchronize, user]);

  useEffect(() => {
    if (!user) return;
    const online = () => void synchronize(user.uid);
    const visible = () => {
      if (document.visibilityState === "visible") void synchronize(user.uid);
    };
    const focused = () => void synchronize(user.uid);
    window.addEventListener("online", online);
    window.addEventListener("focus", focused);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("focus", focused);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [synchronize, user]);

  useEffect(() => {
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js");
  }, []);

  async function attachLocalDataToAccount(targetUid: string, sourceUid: string) {
    if (!sourceUid || sourceUid === targetUid || !sourceUid.startsWith("local-")) return;
    await db.transaction("rw", db.products, db.sales, db.expenses, db.debts, db.debtPayments, async () => {
      const [localProducts, localSales, localExpenses, localDebts, localPayments] = await Promise.all([
        db.products.where("ownerUid").equals(sourceUid).toArray(),
        db.sales.where("ownerUid").equals(sourceUid).toArray(),
        db.expenses.where("ownerUid").equals(sourceUid).toArray(),
        db.debts.where("ownerUid").equals(sourceUid).toArray(),
        db.debtPayments.where("ownerUid").equals(sourceUid).toArray(),
      ]);
      for (const item of localProducts) await db.products.put({ ...item, ownerUid: targetUid, synced: false });
      for (const item of localSales) await db.sales.put({ ...item, ownerUid: targetUid, synced: false });
      for (const item of localExpenses) await db.expenses.put({ ...item, ownerUid: targetUid, synced: false });
      for (const item of localDebts) await db.debts.put({ ...item, ownerUid: targetUid, synced: false });
      for (const item of localPayments) await db.debtPayments.put({ ...item, ownerUid: targetUid, synced: false });
    });
    localStorage.setItem(`zambo-shop-name:${targetUid}`, shopName || "Ma boutique");
    localStorage.setItem(`zambo-currency:${targetUid}`, currency || CURRENCY);
    localStorage.setItem(`zambo-shop-pending:${targetUid}`, "true");
  }

  async function createAccountWithoutSms() {
    const currentAuth = auth;
    const normalizedPhone = normalizeBurkinaPhone(phone);
    if (!currentAuth) return setAuthMessage("La création de compte Firebase n’est pas disponible pour le moment.");
    if (!normalizedPhone) return setAuthMessage("Saisissez un numéro valide avec l’indicatif +226, par exemple +226 70 00 00 00.");
    setPhone(normalizedPhone);
    setAuthBusy(true);
    setMigrationBusy(true);
    migratingRef.current = true;
    setAuthMessage("");
    try {
      const sourceUid = ownerUid;
      const credential = currentAuth.currentUser
        ? { user: currentAuth.currentUser }
        : await signInAnonymously(currentAuth);
      const targetUid = credential.user.uid;
      const pendingName = localStorage.getItem(`zambo-shop-name:${targetUid}`) || shopName || "Ma boutique";
      const pendingCurrency = localStorage.getItem(`zambo-currency:${targetUid}`) || currency || CURRENCY;
      localStorage.setItem(`zambo-shop-phone:${targetUid}`, normalizedPhone);
      await saveShopProfile(targetUid, { name: pendingName, currency: pendingCurrency, phone: normalizedPhone });
      localStorage.removeItem(`zambo-shop-pending:${targetUid}`);
      await attachLocalDataToAccount(targetUid, sourceUid);
      localStorage.removeItem(`zambo-shop-pending:${targetUid}`);
      const cloudShop = await loadCloudData(targetUid);
      if (cloudShop.shop) setShop(cloudShop.shop);
      setOwnerUid(targetUid);
      setUser(credential.user);
      await syncPending(targetUid, isActivePremium(cloudShop.shop));
      await refreshLocal(targetUid);
      setAuthMessage(modal === "cloud-sync"
        ? "Compte Firebase créé sans code SMS. Vos données sont synchronisées en ligne."
        : "Compte créé sans code SMS. Votre abonnement attend son activation via WhatsApp.");
      notify("success", modal === "cloud-sync"
        ? "Compte Firebase créé et données synchronisées."
        : "Compte Firebase créé. Envoyez votre UID sur WhatsApp pour demander l’activation Premium.");
      if (modal === "premium") {
        window.location.assign(whatsappActivationUrl(targetUid, pendingName, normalizedPhone));
      }
    } catch (error) {
      console.error("Firebase anonymous account creation failed", error);
      setAuthMessage("Impossible de créer le compte ou d’enregistrer vos données. Vérifiez Firebase et votre connexion.");
    } finally {
      migratingRef.current = false;
      setMigrationBusy(false);
      setAuthBusy(false);
    }
  }

  function openPremiumRequest() {
    setPhone(user?.phoneNumber ?? "");
    setAuthMessage("");
    setModal("premium");
  }

  function openCloudSync() {
    setPhone(user?.phoneNumber ?? shop?.phone ?? "");
    setAuthMessage("");
    setModal("cloud-sync");
  }

  async function saveShopSettings() {
    const name = shopName.trim();
    if (!name) return notify("error", "Saisissez le nom de votre boutique.");
    setShop({ ...(shop ?? { ownerUid, subscriptionStatus: "FREE" }), name, currency });
    localStorage.setItem(`zambo-shop-name:${ownerUid}`, name);
    localStorage.setItem(`zambo-currency:${ownerUid}`, currency);
    if (user && navigator.onLine) {
      try {
        await saveShopProfile(ownerUid, { name, currency });
        localStorage.removeItem(`zambo-shop-pending:${ownerUid}`);
        const response = await loadCloudData(ownerUid);
        if (response.shop) setShop(response.shop);
      } catch (error) {
        console.error("Could not save shop profile", error);
        localStorage.setItem(`zambo-shop-pending:${ownerUid}`, "true");
        notify("error", "Nom enregistré localement, mais non synchronisé avec la base.");
        return;
      }
    } else if (user) {
      localStorage.setItem(`zambo-shop-pending:${ownerUid}`, "true");
    }
    notify("success", "Paramètres de la boutique enregistrés.");
  }

  async function addProduct(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = {
      name: draft.name.trim(),
      category: draft.category.trim(),
      costPrice: Number(draft.costPrice),
      sellingPrice: Number(draft.sellingPrice),
      stock: Number(draft.stock),
      lowStockThreshold: draft.lowStockThreshold === "" ? 5 : Number(draft.lowStockThreshold),
    };
    if (
      !values.name ||
      !Number.isInteger(values.sellingPrice) ||
      values.sellingPrice <= 0 ||
      !Number.isInteger(values.stock) ||
      values.stock < 0 ||
      !Number.isInteger(values.lowStockThreshold) ||
      values.lowStockThreshold < 0 ||
      !Number.isInteger(values.costPrice) ||
      values.costPrice < 0
    ) {
      return notify("error", "Vérifiez les informations du produit.");
    }
    if (!editingProduct && !premium && products.length >= 30) {
      setModal(null);
      setSection("settings");
      return notify("error", "L’offre gratuite est limitée à 30 produits.");
    }
    const product: Product = editingProduct
      ? { ...editingProduct, ...values, updatedAt: new Date().toISOString(), synced: false }
      : {
          id: newId(),
          ownerUid,
          ...values,
          updatedAt: new Date().toISOString(),
          synced: false,
        };
    if (editingProduct) await db.products.put(product);
    else await db.products.add(product);
    setModal(null);
    setEditingProduct(null);
    setDraft({ name: "", category: "", costPrice: "", sellingPrice: "", stock: "", lowStockThreshold: "5" });
    await refreshLocal();
    notify("success", editingProduct ? "Produit modifié." : "Produit ajouté.");
    void synchronize();
  }

  function openProductEditor(product: Product) {
    setEditingProduct(product);
    setDraft({
      name: product.name,
      category: product.category,
      costPrice: String(product.costPrice),
      sellingPrice: String(product.sellingPrice),
      stock: String(product.stock),
      lowStockThreshold: String(product.lowStockThreshold),
    });
    setModal("product");
  }

  async function deleteProduct(product: Product) {
    if (!window.confirm(`Supprimer le produit « ${product.name} » ? Les ventes déjà enregistrées seront conservées.`)) return;
    await db.products.update(product.id, { isDeleted: true, updatedAt: new Date().toISOString(), synced: false });
    await refreshLocal();
    notify("success", "Produit supprimé. Les ventes existantes sont conservées.");
    void synchronize();
  }

  async function recordSale(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const product = products.find((item) => item.id === saleProductId);
    const quantity = Number(saleQuantity);
    if (!product || !Number.isInteger(quantity) || quantity < 1) {
      return notify("error", "Choisissez un produit et une quantité valide.");
    }
    const availableStock = product.stock + (editingSale?.items.find((item) => item.productId === product.id)?.quantity ?? 0);
    if (availableStock < quantity) return notify("error", "Stock insuffisant pour cette vente.");
    if (editingSale) {
      await updateSale(editingSale, product, quantity);
      return;
    }
    const saleId = newId();
    const sale: Sale = {
      id: saleId,
      ownerUid,
      total: product.sellingPrice * quantity,
      createdAt: new Date().toISOString(),
      items: [{
        id: newId(),
        productId: product.id,
        productName: product.name,
        quantity,
        unitPrice: product.sellingPrice,
        costPrice: product.costPrice,
      }],
      synced: false,
    };
    try {
      await db.transaction("rw", db.products, db.sales, async () => {
        const currentProduct = await db.products.get(product.id);
        if (!currentProduct || currentProduct.stock < quantity) throw new Error("Insufficient stock");
        await db.products.update(product.id, {
          stock: currentProduct.stock - quantity,
          updatedAt: new Date().toISOString(),
          synced: false,
        });
        await db.sales.add(sale);
      });
    } catch (error) {
      console.error("Sale could not be recorded", error);
      return notify("error", "Stock insuffisant ou vente impossible. Vérifiez le stock puis réessayez.");
    }
    setModal(null);
    setSaleProductId("");
    setSaleQuantity("1");
    setSelectedReceipt(sale);
    if (premium) setModal("receipt");
    await refreshLocal();
    notify(
      "success",
      premium
        ? `Vente enregistrée : ${money(sale.total, currency)}. Votre reçu est prêt.`
        : `Vente enregistrée : ${money(sale.total, currency)}. Les reçus sont disponibles avec Premium.`,
    );
    void synchronize();
  }

  async function updateSale(sale: Sale, product: Product, quantity: number) {
    try {
      await db.transaction("rw", db.products, db.sales, async () => {
        const currentSale = await db.sales.get(sale.id);
        if (!currentSale || currentSale.isDeleted) throw new Error("Sale no longer exists");
        const returnedByProduct = new Map<string, number>();
        for (const item of currentSale.items) {
          returnedByProduct.set(item.productId, (returnedByProduct.get(item.productId) ?? 0) + item.quantity);
        }
        const adjustedProducts = new Map<string, Product>();
        for (const [productId, returnedQuantity] of returnedByProduct) {
          const currentProduct = await db.products.get(productId);
          if (currentProduct && !currentProduct.isDeleted) {
            adjustedProducts.set(productId, {
              ...currentProduct,
              stock: currentProduct.stock + returnedQuantity,
              updatedAt: new Date().toISOString(),
              synced: false,
            });
          }
        }
        const target = adjustedProducts.get(product.id) ?? await db.products.get(product.id);
        if (!target || target.isDeleted || target.stock < quantity) throw new Error("Insufficient stock");
        adjustedProducts.set(product.id, {
          ...target,
          stock: target.stock - quantity,
          updatedAt: new Date().toISOString(),
          synced: false,
        });
        for (const updatedProduct of adjustedProducts.values()) await db.products.put(updatedProduct);
        await db.sales.put({
          ...currentSale,
          total: product.sellingPrice * quantity,
          items: [{
            id: currentSale.items[0]?.id ?? newId(),
            productId: product.id,
            productName: product.name,
            quantity,
            unitPrice: product.sellingPrice,
            costPrice: product.costPrice,
          }],
          synced: false,
        });
      });
    } catch (error) {
      console.error("Sale could not be updated", error);
      return notify("error", "Modification impossible : vérifiez le stock disponible puis réessayez.");
    }
    setModal(null);
    setEditingSale(null);
    setSaleProductId("");
    setSaleQuantity("1");
    await refreshLocal();
    notify("success", "Vente modifiée et stock mis à jour.");
    void synchronize();
  }

  function openSaleEditor(sale: Sale) {
    setEditingSale(sale);
    setSaleProductId(sale.items[0]?.productId ?? "");
    setSaleQuantity(String(sale.items[0]?.quantity ?? 1));
    setModal("sale");
  }

  async function deleteSale(sale: Sale) {
    if (!window.confirm("Supprimer cette vente ? Les quantités vendues seront remises en stock.")) return;
    try {
      await db.transaction("rw", db.products, db.sales, async () => {
        const currentSale = await db.sales.get(sale.id);
        if (!currentSale || currentSale.isDeleted) return;
        for (const item of currentSale.items) {
          const product = await db.products.get(item.productId);
          if (product && !product.isDeleted) {
            await db.products.update(product.id, {
              stock: product.stock + item.quantity,
              updatedAt: new Date().toISOString(),
              synced: false,
            });
          }
        }
        await db.sales.put({ ...currentSale, isDeleted: true, synced: false });
      });
    } catch (error) {
      console.error("Sale could not be deleted", error);
      return notify("error", "La vente n’a pas pu être supprimée.");
    }
    await refreshLocal();
    notify("success", "Vente supprimée et stock remis à jour.");
    void synchronize();
  }

  function openReceipt(sale: Sale) {
    if (!premium) return openPremiumRequest();
    setSelectedReceipt(sale);
    setModal("receipt");
  }

  async function addExpense(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amount = Number(expenseAmount);
    if (!expenseLabel.trim() || !Number.isFinite(amount) || amount <= 0) return notify("error", "Renseignez un libellé et un montant valide.");
    const expense: Expense = {
      id: newId(), ownerUid, label: expenseLabel.trim(), amount, createdAt: new Date().toISOString(), synced: false,
    };
    await db.expenses.add(expense);
    setModal(null);
    setExpenseLabel("");
    setExpenseAmount("");
    await refreshLocal();
    notify("success", "Dépense enregistrée.");
    void synchronize();
  }

  async function addDebt(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!premium) return openPremiumRequest();
    const amount = Number(debtAmount);
    if (!debtName.trim() || !Number.isFinite(amount) || amount <= 0) return notify("error", "Renseignez le nom du client et un montant valide.");
    if (editingDebt) {
      const paid = paidByDebt.get(editingDebt.id) ?? 0;
      if (amount < paid) return notify("error", `Le montant ne peut pas être inférieur aux paiements déjà reçus (${money(paid, currency)}).`);
    }
    const debt: CustomerDebt = editingDebt
      ? {
          ...editingDebt,
          customerName: debtName.trim(),
          phone: debtPhone.trim(),
          amount,
          note: debtNote.trim(),
          isPaid: amount <= (paidByDebt.get(editingDebt.id) ?? 0),
          synced: false,
        }
      : {
          id: newId(), ownerUid, customerName: debtName.trim(), phone: debtPhone.trim(), amount,
          note: debtNote.trim(), isPaid: false, createdAt: new Date().toISOString(), synced: false,
        };
    if (editingDebt) await db.debts.put(debt);
    else await db.debts.add(debt);
    setModal(null);
    setEditingDebt(null);
    setDebtName("");
    setDebtPhone("");
    setDebtAmount("");
    setDebtNote("");
    await refreshLocal();
    notify("success", editingDebt ? "Crédit client modifié." : "Crédit client enregistré.");
    void synchronize();
  }

  function openDebtEditor(debt: CustomerDebt) {
    setEditingDebt(debt);
    setDebtName(debt.customerName);
    setDebtPhone(debt.phone);
    setDebtAmount(String(debt.amount));
    setDebtNote(debt.note);
    setModal("debt");
  }

  async function deleteDebt(debt: CustomerDebt) {
    if (!window.confirm(`Supprimer le crédit de ${debt.customerName} et ses paiements ?`)) return;
    try {
      await db.transaction("rw", db.debts, db.debtPayments, async () => {
        const currentDebt = await db.debts.get(debt.id);
        if (!currentDebt || currentDebt.isDeleted) return;
        const payments = await db.debtPayments.where("debtId").equals(debt.id).toArray();
        for (const payment of payments) {
          await db.debtPayments.put({ ...payment, isDeleted: true, synced: false });
        }
        await db.debts.put({ ...currentDebt, isDeleted: true, synced: false });
      });
    } catch (error) {
      console.error("Customer debt could not be deleted", error);
      return notify("error", "Le crédit client n’a pas pu être supprimé.");
    }
    setSelectedDebt(null);
    setModal(null);
    await refreshLocal();
    notify("success", "Crédit et paiements supprimés.");
    void synchronize();
  }

  async function addDebtPayment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!premium) return openPremiumRequest();
    const debt = selectedDebt;
    const amount = Number(debtPaymentAmount);
    if (!debt || !Number.isInteger(amount) || amount <= 0) {
      return notify("error", "Saisissez un montant de paiement valide.");
    }

    async function updateDebtPayment(event: React.FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!premium) return openPremiumRequest();
      const payment = editingDebtPayment;
      const debt = payment && debts.find((item) => item.id === payment.debtId);
      const amount = Number(debtPaymentAmount);
      if (!payment || !debt || !Number.isInteger(amount) || amount <= 0) {
        return notify("error", "Saisissez un montant de paiement valide.");
      }
      const otherPayments = debtPayments
        .filter((item) => item.debtId === debt.id && item.id !== payment.id)
        .reduce((sum, item) => sum + item.amount, 0);
      if (amount + otherPayments > debt.amount) {
        return notify("error", `Le total des paiements dépasserait le crédit de ${money(debt.amount, currency)}.`);
      }
      try {
        await db.transaction("rw", db.debts, db.debtPayments, async () => {
          await db.debtPayments.put({ ...payment, amount, synced: false });
          await db.debts.put({ ...debt, isPaid: amount + otherPayments >= debt.amount, synced: false });
        });
      } catch (error) {
        console.error("Credit payment could not be updated", error);
        return notify("error", "Le paiement n’a pas pu être modifié.");
      }
      setEditingDebtPayment(null);
      setModal("debt-payment");
      setDebtPaymentAmount("");
      await refreshLocal();
      notify("success", "Paiement modifié.");
      void synchronize();
    }

    async function deleteDebtPayment(payment: DebtPayment) {
      if (!window.confirm("Supprimer ce paiement du crédit ?")) return;
      const debt = debts.find((item) => item.id === payment.debtId);
      if (!debt) return notify("error", "Crédit client introuvable.");
      const remainingPaid = (paidByDebt.get(debt.id) ?? 0) - payment.amount;
      try {
        await db.transaction("rw", db.debts, db.debtPayments, async () => {
          await db.debtPayments.put({ ...payment, isDeleted: true, synced: false });
          await db.debts.put({ ...debt, isPaid: remainingPaid >= debt.amount, synced: false });
        });
      } catch (error) {
        console.error("Credit payment could not be deleted", error);
        return notify("error", "Le paiement n’a pas pu être supprimé.");
      }
      await refreshLocal();
      notify("success", "Paiement supprimé.");
      void synchronize();
    }
    const remaining = remainingForDebt(debt);
    if (amount > remaining) return notify("error", `Le montant dépasse le reste dû (${money(remaining, currency)}).`);
    const payment: DebtPayment = {
      id: newId(),
      ownerUid,
      debtId: debt.id,
      amount,
      createdAt: new Date().toISOString(),
      synced: false,
    };
    const updatedDebt = { ...debt, isPaid: amount === remaining, synced: false };
    await db.transaction("rw", db.debts, db.debtPayments, async () => {
      await db.debtPayments.add(payment);
      await db.debts.put(updatedDebt);
    });
    setDebtPaymentAmount("");
    await refreshLocal();
    notify("success", amount === remaining ? "Crédit entièrement remboursé." : "Paiement partiel enregistré.");
    void synchronize();
  }

  async function exportBackup() {
    const data = {
      format: "zambo-backup-v2",
      exportedAt: new Date().toISOString(),
      shop: { name: shopName, currency },
      products,
      sales,
      expenses,
      debts,
      debtPayments,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `bingi-sauvegarde-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    const exportedAt = new Date().toISOString();
    localStorage.setItem(`zambo-last-backup:${ownerUid}`, exportedAt);
    setLastBackupAt(exportedAt);
    notify("success", "Sauvegarde téléchargée. Gardez ce fichier pour votre prochain téléphone.");
  }

  async function importBackup(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const backup: unknown = JSON.parse(await file.text());
      if (
        !backup ||
        typeof backup !== "object" ||
        !("format" in backup) ||
        (backup.format !== "zambo-backup-v1" && backup.format !== "zambo-backup-v2")
      ) {
        throw new Error("Unsupported backup format");
      }
      const content = backup as {
        shop?: { name?: string; currency?: string };
        products?: Product[];
        sales?: Sale[];
        expenses?: Expense[];
        debts?: CustomerDebt[];
        debtPayments?: DebtPayment[];
      };
      if (
        !Array.isArray(content.products) ||
        !Array.isArray(content.sales) ||
        !Array.isArray(content.expenses) ||
        !Array.isArray(content.debts) ||
        (content.debtPayments !== undefined && !Array.isArray(content.debtPayments))
      ) {
        throw new Error("Invalid backup data");
      }
      await db.transaction("rw", db.products, db.sales, db.expenses, db.debts, db.debtPayments, async () => {
        for (const item of content.products ?? []) await db.products.put({ ...item, ownerUid, synced: false });
        for (const item of content.sales ?? []) await db.sales.put({ ...item, ownerUid, synced: false });
        for (const item of content.expenses ?? []) await db.expenses.put({ ...item, ownerUid, synced: false });
        for (const item of content.debts ?? []) await db.debts.put({ ...item, ownerUid, isPaid: item.isPaid ?? false, synced: false });
        for (const item of content.debtPayments ?? []) await db.debtPayments.put({ ...item, ownerUid, synced: false });
      });
      if (content.shop && typeof content.shop.name === "string" && typeof content.shop.currency === "string") {
        setShopName(content.shop.name);
        setCurrency(content.shop.currency);
        setShop((current) => current ? { ...current, name: content.shop!.name!, currency: content.shop!.currency! } : current);
        localStorage.setItem(`zambo-shop-name:${ownerUid}`, content.shop.name);
        localStorage.setItem(`zambo-currency:${ownerUid}`, content.shop.currency);
      }
      await refreshLocal();
      notify("success", "Sauvegarde récupérée. Vos articles, ventes et paiements sont restaurés.");
      void synchronize();
    } catch (error) {
      console.error("Backup import failed", error);
      notify("error", "Fichier invalide ou sauvegarde incompatible.");
    } finally {
      event.target.value = "";
    }
  }

  function shareReceipt(sale: Sale) {
    window.open(`https://wa.me/?text=${encodeURIComponent(receiptText(sale, shopName, currency))}`, "_blank", "noopener,noreferrer");
  }

  const normalizedPhone = normalizeBurkinaPhone(phone);
  const accountActivationUrl = user
    ? whatsappActivationUrl(user.uid, shopName, shop?.phone ?? user.phoneNumber ?? normalizedPhone ?? "non renseigné")
    : "";

  if (!ownerUid) {
    return <main className="startup-screen"><span className="brand-mark">B</span><p>Ouverture de votre boutique…</p></main>;
  }

  const pageTitle = {
    dashboard: "Accueil",
    products: "Produits & stock",
    sales: "Ventes",
    expenses: "Dépenses",
    debts: "Crédits clients",
    reports: "Bilans détaillés",
    settings: "Paramètres",
  }[section];

  const visibleSales = sales;
  const totalExpenses = expenses.reduce((sum, expense) => sum + expense.amount, 0);
  const outstandingDebts = debts.reduce((sum, debt) => sum + remainingForDebt(debt), 0);
  const totalProfit = sales.reduce((sum, sale) => sum + sale.items.reduce((subtotal, item) => subtotal + (item.unitPrice - item.costPrice) * item.quantity, 0), 0);
  const stockValue = products.reduce((sum, product) => sum + product.costPrice * product.stock, 0);
  const reportSales = sales.filter((sale) => isOnDay(sale.createdAt, reportDate));
  const reportExpenses = expenses.filter((expense) => isOnDay(expense.createdAt, reportDate));
  const reportDebts = debts.filter((debt) => isOnDay(debt.createdAt, reportDate));
  const reportPayments = debtPayments.filter((payment) => isOnDay(payment.createdAt, reportDate));
  const reportSalesTotal = reportSales.reduce((sum, sale) => sum + sale.total, 0);
  const reportExpenseTotal = reportExpenses.reduce((sum, expense) => sum + expense.amount, 0);
  const reportDebtTotal = reportDebts.reduce((sum, debt) => sum + debt.amount, 0);
  const reportPaymentTotal = reportPayments.reduce((sum, payment) => sum + payment.amount, 0);
  const reportCashCollected = reportSalesTotal + reportPaymentTotal;
  const backupReminder = !lastBackupAt || Date.now() - new Date(lastBackupAt).getTime() >= 7 * 86400000;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => setSection("dashboard")}><span className="brand-mark">B</span><span>Bĩngi<small>VOTRE BOUTIQUE</small></span></button>
        <div className="shop-switcher"><div className="shop-avatar">{(shopName || "M").slice(0, 1).toUpperCase()}</div><div><strong>{shopName || "Ma boutique"}</strong><small>{user ? "Boutique sauvegardée en ligne" : "Mode gratuit · sans compte"}</small></div><span className="chevron">⌄</span></div>
        <span className="nav-caption">MENU PRINCIPAL</span>
        <nav className="main-nav">
          {navItems.map((item) => (
            <button key={item.id} className={`nav-link ${section === item.id ? "active" : ""}`} onClick={() => setSection(item.id)}>
              <span className="nav-icon">{item.icon}</span><span>{item.label}</span>{item.premium && !premium && <span className="pro-tag">PRO</span>}
            </button>
          ))}
          <button className={`nav-link mobile-settings ${section === "settings" ? "active" : ""}`} onClick={() => setSection("settings")}><span className="nav-icon">⚙</span><span>Paramètres</span></button>
        </nav>
        <div className="sidebar-bottom">
          <div className={`plan-card ${premium ? "plan-active" : ""}`}><div className="plan-card-top"><span>{premium ? "✦ PREMIUM" : "OFFRE GRATUITE"}</span><span>{premium ? "●" : "↗"}</span></div><strong>{premium ? "Votre boutique est Premium" : "Les outils essentiels sont gratuits"}</strong><p>{premium ? "Merci de soutenir Bĩngi." : "Stock, ventes et sauvegarde en ligne gratuite."}</p>{!premium && <button onClick={() => setSection("settings")}>Voir Premium <span>→</span></button>}</div>
          <button className={`nav-link ${section === "settings" ? "active" : ""}`} onClick={() => setSection("settings")}><span className="nav-icon">⚙</span><span>Paramètres</span></button>
          <div className="profile-row"><div className="profile-avatar">{(shop?.phone ?? user?.phoneNumber)?.slice(-2) ?? "Z"}</div><div className="profile-info"><strong>{user ? shop?.phone ?? user.phoneNumber ?? "Compte Firebase" : "Sans compte"}</strong><small>{user ? (premium ? "Compte Premium" : "Compte en ligne gratuit") : "Données sur cet appareil"}</small></div>{user && !user.isAnonymous && <button className="more-button" aria-label="Déconnexion" title="Déconnecter le compte en ligne" onClick={async () => { if (auth) await signOut(auth); }}>⋯</button>}</div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar"><div className="breadcrumbs"><span>Ma boutique</span><b>/</b><strong>{pageTitle}</strong></div><div className="top-actions"><div className={`connection-pill ${syncing ? "busy" : ""}`}><span />{user ? (syncing ? "Sauvegarde…" : "Données sauvegardées") : "Enregistré sur cet appareil"}</div><button className="icon-button" title="Alertes de stock" onClick={() => setSection("products")}>♧{lowStock.length > 0 && <i />}</button><div className="top-avatar">{shopName.slice(0, 1).toUpperCase() || "M"}</div></div></header>
        <div className="page-content">
          <div className="page-heading"><div><span className="eyebrow">{new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" }).toUpperCase()}</span><h1>{section === "dashboard" ? `Bonjour${shopName ? `, ${shopName}` : ""} 👋` : pageTitle}</h1><p>{section === "dashboard" ? "Votre activité, simplement. Vous pouvez utiliser l’application sans créer de compte." : "Les informations sont enregistrées automatiquement."}</p></div><div className="heading-actions">{section === "dashboard" && products.length > 0 && <button className="button button-outline" onClick={() => setSection("sales")}>＋ Nouvelle vente</button>}{section === "dashboard" && products.length === 0 && <button className="button button-primary" onClick={() => setModal("product")}>＋ Ajouter mon premier produit</button>}{section === "products" && <button className="button button-primary" onClick={() => setModal("product")}>＋ Ajouter un produit</button>}{section === "sales" && <button className="button button-primary" onClick={() => setModal("sale")}>＋ Nouvelle vente</button>}</div></div>

          {loading && <div className="loading-banner">Chargement de vos données…</div>}

          {section === "dashboard" && products.length === 0 && <section className="starter-card">
            <div className="starter-number">1</div>
            <div className="starter-copy"><strong>Commençons simplement</strong><span>Ajoutez vos articles. Ensuite, touchez « Vendre » à chaque vente : le stock se mettra à jour tout seul.</span></div>
            <button className="button button-primary" onClick={() => { setEditingProduct(null); setModal("product"); }}>Ajouter mon premier article</button>
          </section>}
          {section === "dashboard" && backupReminder && <section className="backup-reminder">
            <div><strong>{lastBackupAt ? "Pensez à refaire votre sauvegarde" : "Protégez les données de votre boutique"}</strong><span>{lastBackupAt ? `Dernière copie : ${dayLabel(lastBackupAt)}. Téléchargez une nouvelle copie avant de changer de téléphone.` : user ? "Vos données sont aussi synchronisées en ligne. Téléchargez une copie supplémentaire pour plus de sécurité." : "Les données gratuites sont gardées sur ce téléphone. Téléchargez une copie, puis sur le nouveau téléphone ouvrez Paramètres > Récupérer une sauvegarde."}</span></div>
            <button className="button button-outline" onClick={() => void exportBackup()}>Télécharger une copie</button>
          </section>}
          {section === "dashboard" && <Dashboard
            revenue={todayRevenue} saleCount={todaySales.length} profit={todayProfit} stockCount={products.length}
            lowStock={lowStock} sales={visibleSales.slice(0, 5)} currency={currency} premium={premium}
            onNewSale={() => { setEditingSale(null); setModal("sale"); }} onNewProduct={() => { setEditingProduct(null); setModal("product"); }} onProducts={() => setSection("products")} onAllSales={() => setSection("sales")}
            onReceipt={openReceipt}
          />}
          {section === "products" && <section className="panel"><div className="panel-toolbar"><div><h2>Mes articles</h2><p>{products.length} article{products.length === 1 ? "" : "s"} · {premium ? "Autant que vous voulez" : `${Math.max(0, 30 - products.length)} places gratuites restantes`}</p></div><div className="search-field"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Chercher un article…" /></div></div><ProductsTable products={filteredProducts} currency={currency} onRestock={async (product) => { await db.products.update(product.id, { stock: product.stock + 1, updatedAt: new Date().toISOString(), synced: false }); await refreshLocal(); void synchronize(); }} onEdit={openProductEditor} onDelete={(product) => void deleteProduct(product)} /></section>}
          {section === "sales" && <section className="panel"><div className="panel-toolbar"><div><h2>Mes ventes</h2><p>{sales.length} vente(s) gardée(s) · historique complet gratuit</p></div><button className="button button-primary" onClick={() => { setEditingSale(null); setModal("sale"); }}>＋ Enregistrer une vente</button></div><SalesTable sales={visibleSales} currency={currency} onReceipt={openReceipt} premium={premium} onEdit={openSaleEditor} onDelete={(sale) => void deleteSale(sale)} /></section>}
          {section === "expenses" && <section className="panel"><div className="panel-toolbar"><div><h2>Suivi des dépenses</h2><p>Total enregistré : <b>{money(totalExpenses, currency)}</b></p></div><button className="button button-primary" onClick={() => setModal("expense")}>＋ Ajouter une dépense</button></div><ExpenseTable expenses={expenses} currency={currency} /></section>}
          {section === "debts" && (premium ? <section className="panel"><div className="panel-toolbar"><div><h2>Crédits clients</h2><p>Montant restant à récupérer : <b>{money(outstandingDebts, currency)}</b></p></div><button className="button button-primary" onClick={() => { setEditingDebt(null); setModal("debt"); }}>＋ Ajouter un crédit</button></div><DebtTable debts={debts} currency={currency} remainingForDebt={remainingForDebt} onPayment={(debt) => { setSelectedDebt(debt); setDebtPaymentAmount(""); setModal("debt-payment"); }} onEdit={openDebtEditor} onDelete={(debt) => void deleteDebt(debt)} /></section> : <PremiumGate feature="Les crédits clients et leurs paiements en plusieurs fois sont inclus dans Premium." onUpgrade={openPremiumRequest} accountInactive={Boolean(user && shop?.estActif !== true)} userId={user?.uid} whatsappUrl={accountActivationUrl} onRefresh={() => void synchronize()} refreshing={syncing} />)}
          {section === "reports" && premium && <div className="report-page">
            <section className="panel">
              <div className="panel-toolbar"><div><h2>Bilan de la journée</h2><p>Vos ventes, sorties d’argent et crédits clients du jour choisi.</p></div><label className="report-date">Journée<input type="date" value={reportDate} onChange={(event) => setReportDate(event.target.value)} /></label></div>
              <div className="metrics-grid">
                <MetricCard label="Ventes" value={money(reportSalesTotal, currency)} icon="↗" tone="green" hint={`${reportSales.length} vente(s)`} />
                <MetricCard label="Dépenses" value={money(reportExpenseTotal, currency)} icon="↘" tone="gold" hint={`${reportExpenses.length} dépense(s)`} />
                <MetricCard label="Crédits accordés" value={money(reportDebtTotal, currency)} icon="◷" tone="rose" hint={`${reportDebts.length} crédit(s)`} />
                <MetricCard label="Argent encaissé" value={money(reportCashCollected, currency)} icon="✓" tone="blue" hint={`${money(reportPaymentTotal, currency)} de remboursements inclus`} />
              </div>
              <p className="report-explainer">L’argent encaissé comprend les ventes enregistrées et les remboursements de crédits reçus ce jour. Les dépenses sont affichées séparément.</p>
              <div className="report-summary"><SummaryLine label="Remboursements de crédits reçus" value={money(reportPaymentTotal, currency)} /><SummaryLine label="Dépenses du jour" value={`− ${money(reportExpenseTotal, currency)}`} /><SummaryLine label="Encaissements après dépenses" value={money(reportCashCollected - reportExpenseTotal, currency)} bold /></div>
            </section>
            <div className="metrics-grid">
              <MetricCard label="Bénéfice brut estimé" value={money(totalProfit, currency)} icon="↗" tone="green" hint="Ventes moins prix d’achat" />
              <MetricCard label="Dépenses enregistrées" value={money(totalExpenses, currency)} icon="↘" tone="gold" hint={`${expenses.length} dépense(s)`} />
              <MetricCard label="Valeur du stock" value={money(stockValue, currency)} icon="▤" tone="blue" hint="Au prix d’achat" />
              <MetricCard label="Crédits à récupérer" value={money(outstandingDebts, currency)} icon="◷" tone="rose" hint={`${debts.filter((debt) => remainingForDebt(debt) > 0).length} crédit(s) en cours`} />
            </div>
            <div className="report-grid"><section className="panel"><div className="panel-toolbar"><div><h2>Activité récente</h2><p>Vos ventes enregistrées</p></div></div><SalesTable sales={sales} currency={currency} onReceipt={openReceipt} premium={premium} /></section><section className="panel report-summary"><h2>Résumé de la boutique</h2><SummaryLine label="Argent des ventes" value={money(sales.reduce((sum, sale) => sum + sale.total, 0), currency)} /><SummaryLine label="Bénéfice brut" value={money(totalProfit, currency)} /><SummaryLine label="Dépenses" value={`− ${money(totalExpenses, currency)}`} /><SummaryLine label="Bénéfice après dépenses" value={money(totalProfit - totalExpenses, currency)} bold /></section></div>
          </div>}
          {section === "reports" && !premium && <PremiumGate feature="Les bilans journaliers et les rapports détaillés sont inclus dans Premium. Le bénéfice estimé du jour reste gratuit sur l’accueil." onUpgrade={openPremiumRequest} accountInactive={Boolean(user && shop?.estActif !== true)} userId={user?.uid} whatsappUrl={accountActivationUrl} onRefresh={() => void synchronize()} refreshing={syncing} />}
          {section === "settings" && <div className="settings-layout">
            <section className="panel settings-panel">
              <div className="panel-toolbar"><div><h2>Ma boutique</h2><p>Donnez un nom à votre commerce pour le reconnaître facilement.</p></div></div>
              <label>Nom de la boutique<input className="form-input" value={shopName} onChange={(event) => setShopName(event.target.value)} placeholder="Ex. Boutique Awa" /></label>
              <label>Monnaie utilisée<input className="form-input" value="Franc CFA (FCFA)" readOnly /></label>
              <button className="button button-primary" onClick={() => void saveShopSettings()}>Enregistrer</button>
              <div className="settings-divider" />
              <h2>Garder une copie de mes données</h2>
              <p>{user ? "Vos données sont synchronisées en ligne et restent disponibles hors ligne sur cet appareil. Une copie téléchargée ajoute une sécurité supplémentaire." : "Vos données gratuites restent sur ce téléphone. Téléchargez régulièrement une sauvegarde, surtout avant de changer d’appareil."}</p>
              <div className="backup-status">{lastBackupAt ? `Dernière sauvegarde téléchargée le ${dayLabel(lastBackupAt)}.` : "Vous n’avez pas encore téléchargé de sauvegarde."}</div>
              <div className="backup-actions">
                <button className="button button-outline" onClick={() => void exportBackup()}>↓ Télécharger ma sauvegarde</button>
                <label className="button button-outline import-button">↑ Récupérer une sauvegarde<input type="file" accept="application/json,.json" onChange={(event) => void importBackup(event)} /></label>
              </div>
              <div className="backup-guide"><strong>Pour changer de téléphone</strong><span>1. Téléchargez la sauvegarde sur cet appareil.</span><span>2. Envoyez le fichier sur le nouveau téléphone.</span><span>3. Dans Bĩngi, ouvrez Paramètres puis « Récupérer une sauvegarde ».</span></div>
              <div className="settings-divider" />
              <h2>Sauvegarde en ligne</h2>
              <p>{user ? `Le compte Firebase anonyme synchronise vos données en ligne. Il reste lié à cet appareil et ne peut pas être retrouvé avec le numéro ${shop?.phone ?? user.phoneNumber ?? "fourni"} seul.` : "Activez gratuitement la sauvegarde en ligne avec votre numéro de téléphone. Vous pouvez aussi continuer sans compte et utiliser les sauvegardes manuelles."}</p>
              {user
                ? <button className="button button-outline" disabled={syncing} onClick={() => void synchronize()}>{syncing ? "Sauvegarde en cours…" : "↻ Sauvegarder maintenant"}</button>
                : firebaseConfigured
                  ? <button className="button button-outline" onClick={openCloudSync}>Activer la sauvegarde gratuite →</button>
                  : <p className="setup-notice"><strong>Sauvegarde en ligne indisponible.</strong><span>La configuration Firebase de l’application est nécessaire. Vos données restent enregistrées sur cet appareil.</span></p>}
            </section>
            <section className={`premium-card ${premium ? "premium-card-on" : ""}`}>
              <span className="premium-spark">✦</span><span className="eyebrow">{premium ? "VOTRE ABONNEMENT" : "BĨNGI PREMIUM"}</span>
              {user && shop?.estActif !== true && <div className="payment-help"><strong>Votre abonnement attend son activation</strong><span>Après vérification de votre paiement, l’administrateur activera votre compte dans Firebase. Votre UID : <code>{user.uid}</code>.</span>{accountActivationUrl && <a className="button button-whatsapp request-whatsapp" href={accountActivationUrl} target="_blank" rel="noreferrer">Activer mon abonnement via WhatsApp ↗</a>}<button className="button button-outline" onClick={() => void synchronize()} disabled={syncing}>{syncing ? "Vérification…" : "Vérifier si mon abonnement est activé"}</button></div>}
              <h2>{premium ? "Votre boutique est Premium" : "Des outils avancés pour votre boutique."}</h2>
              <p>{premium ? `Votre accès est actif${shop?.subscriptionExpiresAt ? ` jusqu’au ${dayLabel(shop.subscriptionExpiresAt)}` : ""}.` : "La gestion quotidienne et la sauvegarde en ligne restent gratuites. Premium ajoute des outils avancés et davantage de capacité."}</p>
              <ul><li>✓ Gratuit : stock, ventes, dépenses et historique complet</li><li>✓ Gratuit : bénéfice estimé et sauvegarde en ligne</li><li>✓ Premium : reçu WhatsApp et impression après chaque vente</li><li>✓ Premium : crédits clients et paiements partiels</li><li>✓ Premium : bilans journaliers, rapports détaillés et plus de 30 articles</li></ul>
              {!premium && !(user && shop?.estActif !== true) && <><div className="premium-price">1 000 <small>FCFA pour un mois</small></div><button className="button button-whatsapp" onClick={openPremiumRequest}>Demander Premium →</button><small className="manual-note">Vous payez seulement après avoir reçu les instructions. Paiement vérifié par une personne.</small></>}
            </section>
          </div>}
        </div>
      </main>

      {modal && <div className="modal-backdrop" onClick={() => setModal(null)}><div className={`modal ${modal === "receipt" ? "receipt-modal" : ""}`} onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">BĨNGI · {shopName || "MA BOUTIQUE"}</span><h2>{modal === "product" ? "Ajouter un article" : modal === "sale" ? "Enregistrer une vente" : modal === "expense" ? "Ajouter une dépense" : modal === "debt" ? "Ajouter un crédit client" : modal === "debt-payment" ? "Paiement du crédit" : modal === "receipt" ? "Reçu de vente" : modal === "cloud-sync" ? "Sauvegarde en ligne gratuite" : "Passer à Premium"}</h2></div><button className="close-button no-print" onClick={() => setModal(null)} aria-label="Fermer">×</button></div>
        {modal === "product" && <form className="modal-form" onSubmit={(event) => void addProduct(event)}><p className="form-help">Quelques informations suffisent. Vous pourrez ajouter le reste plus tard.</p><label>Nom de l’article<input required autoFocus value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Ex. Riz local, savon, huile…" /></label><label>Prix de vente (FCFA)<input required type="number" min="0" step="1" value={draft.sellingPrice} onChange={(event) => setDraft({ ...draft, sellingPrice: event.target.value })} placeholder="Ex. 1 000" /></label><label>Quantité en boutique<input required type="number" min="0" step="1" value={draft.stock} onChange={(event) => setDraft({ ...draft, stock: event.target.value })} placeholder="Ex. 10" /></label><details className="optional-fields"><summary>Ajouter des détails (facultatif)</summary><div className="optional-field-content"><label>Catégorie<input value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} placeholder="Ex. Alimentation" /></label><label>Prix d’achat (FCFA)<input type="number" min="0" step="1" value={draft.costPrice} onChange={(event) => setDraft({ ...draft, costPrice: event.target.value })} placeholder="Pour calculer les bénéfices" /></label><label>M’avertir quand il en reste<input type="number" min="0" step="1" value={draft.lowStockThreshold} onChange={(event) => setDraft({ ...draft, lowStockThreshold: event.target.value })} /></label></div></details><ModalActions onCancel={() => setModal(null)} submit="Enregistrer l’article" /></form>}
        {modal === "sale" && <form className="modal-form" onSubmit={(event) => void recordSale(event)}><label>Produit<select required value={saleProductId} onChange={(event) => setSaleProductId(event.target.value)}><option value="">Choisir un produit</option>{products.filter((product) => product.stock > 0).map((product) => <option key={product.id} value={product.id}>{product.name} · {product.stock} disponible(s) · {money(product.sellingPrice, currency)}</option>)}</select></label><label>Quantité<input required type="number" min="1" step="1" max={products.find((product) => product.id === saleProductId)?.stock ?? undefined} value={saleQuantity} onChange={(event) => setSaleQuantity(event.target.value)} /></label>{saleProductId && <div className="sale-total">Total estimé <strong>{money((products.find((product) => product.id === saleProductId)?.sellingPrice ?? 0) * Number(saleQuantity), currency)}</strong></div>}<ModalActions onCancel={() => setModal(null)} submit="Confirmer la vente" /></form>}
        {modal === "expense" && <form className="modal-form" onSubmit={(event) => void addExpense(event)}><label>Libellé<input required autoFocus value={expenseLabel} onChange={(event) => setExpenseLabel(event.target.value)} placeholder="Ex. Transport, électricité…" /></label><label>Montant ({currency})<input required type="number" min="1" step="1" value={expenseAmount} onChange={(event) => setExpenseAmount(event.target.value)} /></label><ModalActions onCancel={() => setModal(null)} submit="Enregistrer la dépense" /></form>}
        {modal === "debt" && premium && <form className="modal-form" onSubmit={(event) => void addDebt(event)}><label>Nom du client<input required autoFocus value={debtName} onChange={(event) => setDebtName(event.target.value)} placeholder="Ex. Aïssata" /></label><label>Téléphone du client (facultatif)<input value={debtPhone} onChange={(event) => setDebtPhone(event.target.value)} placeholder="+226 70 00 00 00" inputMode="tel" /></label><label>Montant dû (FCFA)<input required type="number" min="1" step="1" value={debtAmount} onChange={(event) => setDebtAmount(event.target.value)} placeholder="Ex. 5 000" /></label><label>Note (facultatif)<textarea value={debtNote} onChange={(event) => setDebtNote(event.target.value)} rows={2} placeholder="Ex. À payer vendredi" /></label><ModalActions onCancel={() => setModal(null)} submit="Enregistrer le crédit" /></form>}
        {(modal === "debt" || modal === "debt-payment") && !premium && <PremiumGate feature="Les crédits clients et leurs paiements en plusieurs fois sont inclus dans Premium." onUpgrade={openPremiumRequest} accountInactive={Boolean(user && shop?.estActif !== true)} userId={user?.uid} whatsappUrl={accountActivationUrl} onRefresh={() => void synchronize()} refreshing={syncing} />}
        {modal === "debt-payment" && premium && selectedDebt && <div className="modal-form">
          <div className="debt-payment-summary"><strong>{selectedDebt.customerName}</strong><span>Montant initial : {money(selectedDebt.amount, currency)}</span><b>Reste à payer : {money(remainingForDebt(selectedDebt), currency)}</b></div>
          {remainingForDebt(selectedDebt) > 0 && <form onSubmit={(event) => void addDebtPayment(event)}>
            <label>Montant reçu (FCFA)<input required autoFocus type="number" min="1" max={remainingForDebt(selectedDebt)} step="1" value={debtPaymentAmount} onChange={(event) => setDebtPaymentAmount(event.target.value)} placeholder="Saisir le paiement reçu" /></label>
            <ModalActions onCancel={() => setModal(null)} submit="Enregistrer le paiement" />
          </form>}
          <div className="payment-history"><h3>Paiements déjà reçus</h3>
            {debtPayments.filter((payment) => payment.debtId === selectedDebt.id).length
              ? debtPayments.filter((payment) => payment.debtId === selectedDebt.id).map((payment) => <div className="payment-history-row" key={payment.id}><span>{dayLabel(payment.createdAt)}</span><strong>{money(payment.amount, currency)}</strong></div>)
              : <p>Aucun paiement enregistré pour le moment.</p>}
          </div>
          {remainingForDebt(selectedDebt) === 0 && <button className="button button-outline" onClick={() => setModal(null)}>Fermer</button>}
        </div>}
        {modal === "receipt" && premium && selectedReceipt && <div className="receipt-content">
          <div className="receipt-paper">
            <div className="receipt-brand">{shopName || "Ma boutique"}</div>
            <p>Reçu de vente · #{selectedReceipt.id.slice(0, 7).toUpperCase()}</p>
            <p>{dayLabel(selectedReceipt.createdAt)} à {new Date(selectedReceipt.createdAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</p>
            <div className="receipt-items">{selectedReceipt.items.map((item) => <div className="receipt-row" key={item.id}><span>{item.quantity} × {item.productName}</span><strong>{money(item.unitPrice * item.quantity, currency)}</strong></div>)}</div>
            <div className="receipt-total"><span>TOTAL</span><strong>{money(selectedReceipt.total, currency)}</strong></div>
            <p className="receipt-thanks">Merci pour votre achat !</p>
          </div>
          <div className="modal-actions no-print"><button className="button button-outline" onClick={() => window.print()}>Imprimer le reçu</button><button className="button button-primary" onClick={() => shareReceipt(selectedReceipt)}>Partager sur WhatsApp</button></div>
        </div>}
        {modal === "receipt" && !premium && <PremiumGate feature="L’impression et le partage WhatsApp des reçus sont inclus dans Premium." onUpgrade={openPremiumRequest} accountInactive={Boolean(user && shop?.estActif !== true)} userId={user?.uid} whatsappUrl={accountActivationUrl} onRefresh={() => void synchronize()} refreshing={syncing} />}
        {modal === "premium" && <div className="premium-request">
          <div className="request-price"><strong>1 000 FCFA</strong><span>pour un mois · aucun prélèvement automatique</span></div>
          {user
            ? <>
                {shop?.estActif === true
                  ? <div className="payment-help"><strong>Renouveler mon abonnement</strong><span>Envoyez votre demande sur WhatsApp. Nous vous confirmerons les instructions de paiement.</span></div>
                  : <div className="payment-help"><strong>Activation de l’abonnement en attente</strong><span>Votre compte Firebase est créé. Envoyez votre UID par WhatsApp pour demander l’activation après paiement.</span><span>Votre UID : <code>{user.uid}</code></span></div>}
                <p className="verified-phone">Numéro fourni (non vérifié) : {shop?.phone ?? user.phoneNumber ?? "non renseigné"}</p>
                {authMessage && <p className="auth-message" role="status">{authMessage}</p>}
                <a className="button button-whatsapp request-whatsapp" href={accountActivationUrl} target="_blank" rel="noreferrer">Activer mon abonnement via WhatsApp ↗</a>
                <button className="button button-outline" onClick={() => void synchronize()} disabled={syncing}>{syncing ? "Vérification…" : "Vérifier mon activation"}</button>
                <button className="text-button premium-cancel" onClick={() => setModal(null)}>Continuer gratuitement</button>
              </>
            : <>
                <p className="request-intro">Saisissez votre numéro. Bĩngi crée votre compte Firebase sans mot de passe ni code SMS, puis ouvre WhatsApp avec votre UID pour demander l’activation de Premium.</p>
                <label>Votre numéro de téléphone<input autoFocus value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+226 70 00 00 00" inputMode="tel" autoComplete="tel" /></label>
                <small className="phone-format-hint">Vous pouvez saisir 8 chiffres ou le numéro complet avec +226.</small>
                {authMessage && !user && <p className="auth-message" role="status">{authMessage}</p>}
                {firebaseConfigured
                  ? <button className="button button-primary" disabled={authBusy || migrationBusy || !phone} onClick={() => void createAccountWithoutSms()}>{authBusy ? "Création du compte…" : migrationBusy ? "Préparation de la boutique…" : "Créer mon compte et ouvrir WhatsApp"}</button>
                  : <div className="setup-notice"><strong>La création de compte n’est pas disponible.</strong><span>Configurez Firebase Authentication avec la connexion anonyme pour créer votre compte. L’offre gratuite reste utilisable sans compte.</span></div>}
                <p className="whatsapp-hint">{firebaseConfigured ? (normalizedPhone ? "Aucun code SMS ne sera demandé. Le numéro sert de contact; l’activation se fait après vérification WhatsApp." : "Saisissez un numéro burkinabè valide pour continuer.") : "Configurez Firebase pour créer votre compte et obtenir votre UID d’activation."}</p>
                <div className="payment-help"><strong>Comment se passe le paiement ?</strong><span>N’envoyez pas d’argent avant d’avoir reçu les instructions via WhatsApp.</span></div>
                <button className="text-button premium-cancel" onClick={() => setModal(null)}>Pas maintenant — continuer gratuitement</button>
              </>}
        </div>}
        {modal === "cloud-sync" && <div className="premium-request">
          <p className="request-intro">Synchronisez gratuitement votre stock et vos ventes avec Firestore. Le compte anonyme restera lié à cet appareil; sans connexion par SMS, le numéro ne permettra pas de le retrouver sur un autre téléphone.</p>
          {!user && <>
            <label>Votre numéro de téléphone<input autoFocus value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+226 70 00 00 00" inputMode="tel" autoComplete="tel" /></label>
            <small className="phone-format-hint">Saisissez les 8 chiffres ou le numéro complet avec +226.</small>
            {authMessage && <p className="auth-message" role="status">{authMessage}</p>}
            <button className="button button-primary" disabled={authBusy || migrationBusy || !phone} onClick={() => void createAccountWithoutSms()}>{authBusy ? "Création du compte…" : migrationBusy ? "Préparation de la boutique…" : "Créer mon compte et synchroniser"}</button>
            <small>Le compte est lié à cet appareil; aucun code SMS n’est envoyé. Le numéro saisi n’est pas vérifié et ne permet pas de récupérer le compte sur un autre appareil.</small>
          </>}
          {user && <>
            <p className="verified-phone">Compte en ligne : {shop?.phone ?? user.phoneNumber ?? "numéro non renseigné"}</p>
            {authMessage && <p className="auth-message" role="status">{authMessage}</p>}
            <button className="button button-outline" onClick={() => void synchronize()} disabled={syncing}>{syncing ? "Synchronisation…" : "↻ Synchroniser maintenant"}</button>
          </>}
          <button className="text-button premium-cancel" onClick={() => setModal(null)}>Fermer</button>
        </div>}
      </div></div>}
      {toast && <div className={`toast ${toast.kind}`} role="status">{toast.kind === "success" ? "✓" : "!"} {toast.text}</div>}
    </div>
  );
}

function Dashboard(props: {
  revenue: number; saleCount: number; profit: number; stockCount: number; lowStock: Product[]; sales: Sale[];
  currency: string; premium: boolean; onNewSale: () => void; onNewProduct: () => void; onProducts: () => void; onAllSales: () => void;
  onReceipt: (sale: Sale) => void;
}) {
  return <><div className="metrics-grid"><MetricCard label="Argent des ventes aujourd’hui" value={money(props.revenue, props.currency)} icon="↗" tone="green" hint={`${props.saleCount} vente${props.saleCount === 1 ? "" : "s"} aujourd’hui`} /><MetricCard label="Bénéfice estimé aujourd’hui" value={money(props.profit, props.currency)} icon="✧" tone="gold" hint="Estimation selon les prix d’achat renseignés" /><MetricCard label="Articles en boutique" value={String(props.stockCount)} icon="▤" tone="blue" hint="Dans votre liste" /><MetricCard label="Articles à racheter" value={String(props.lowStock.length)} icon="!" tone="rose" hint={props.lowStock.length ? "Stock bientôt épuisé" : "Rien à racheter"} /></div><div className="dashboard-grid"><section className="panel sales-panel"><div className="panel-toolbar"><div><h2>Mes dernières ventes</h2><p>Les ventes que vous avez enregistrées</p></div><button className="link-button" onClick={props.onAllSales}>Tout voir →</button></div><SalesTable sales={props.sales} currency={props.currency} compact onReceipt={props.onReceipt} premium={props.premium} /></section><section className="panel stock-panel"><div className="panel-toolbar"><div><h2>À racheter bientôt</h2><p>Articles presque épuisés</p></div><button className="link-button" onClick={props.onProducts}>Voir mes articles →</button></div>{props.lowStock.length ? <div className="alert-list">{props.lowStock.slice(0, 5).map((product) => <div className="alert-row" key={product.id}><div className="product-placeholder">{product.name.slice(0, 1).toUpperCase()}</div><div className="alert-info"><strong>{product.name}</strong><small>{product.category || "Sans catégorie"}</small></div><span className="stock-warning">{product.stock} restant{product.stock === 1 ? "" : "s"}</span></div>)}</div> : <div className="empty-state"><span>{props.stockCount ? "✓" : "＋"}</span><strong>{props.stockCount ? "Tout va bien" : "Ajoutez votre premier article"}</strong><small>{props.stockCount ? "Aucun article n’est bientôt épuisé." : "L’application vous aidera à suivre ce qu’il reste."}</small></div>}{props.stockCount ? <button className="button button-primary full-button" onClick={props.onNewSale}>＋ Enregistrer une vente</button> : <button className="button button-primary full-button" onClick={props.onNewProduct}>＋ Ajouter un article</button>}</section></div></>;
}

function MetricCard({ label, value, icon, tone, hint }: { label: string; value: string; icon: string; tone: string; hint: string }) {
  return <article className="metric-card"><div className={`metric-icon ${tone}`}>{icon}</div><span className="metric-label">{label}</span><strong className="metric-value">{value}</strong><span className="metric-hint">{hint}</span></article>;
}

function ProductsTable({ products, currency, onRestock, onEdit, onDelete }: {
  products: Product[];
  currency: string;
  onRestock: (product: Product) => void;
  onEdit: (product: Product) => void;
  onDelete: (product: Product) => void;
}) {
  if (!products.length) return <Empty message="Aucun produit pour le moment" detail="Ajoutez vos produits pour commencer à suivre le stock." />;
  return <div className="table-wrap"><table><thead><tr><th>PRODUIT</th><th>CATÉGORIE</th><th>PRIX D’ACHAT</th><th>PRIX DE VENTE</th><th>STOCK</th><th>STATUT</th><th>ACTIONS</th></tr></thead><tbody>{products.map((product) => <tr key={product.id}><td><div className="table-product"><div className="product-placeholder">{product.name.slice(0, 1).toUpperCase()}</div><strong>{product.name}</strong></div></td><td>{product.category || "—"}</td><td>{money(product.costPrice, currency)}</td><td className="strong-cell">{money(product.sellingPrice, currency)}</td><td>{product.stock}</td><td><span className={`status ${product.stock <= product.lowStockThreshold ? "status-low" : "status-ok"}`}>{product.stock <= product.lowStockThreshold ? "Stock faible" : "En stock"}</span></td><td><button className="row-action" title="Ajouter une unité" aria-label={`Ajouter une unité à ${product.name}`} onClick={() => onRestock(product)}>＋</button>{" "}<button className="small-action" onClick={() => onEdit(product)}>Modifier</button>{" "}<button className="small-action" onClick={() => onDelete(product)}>Supprimer</button></td></tr>)}</tbody></table></div>;
}

function SalesTable({ sales, currency, compact = false, onReceipt, premium = false, onEdit, onDelete }: {
  sales: Sale[];
  currency: string;
  compact?: boolean;
  onReceipt?: (sale: Sale) => void;
  premium?: boolean;
  onEdit?: (sale: Sale) => void;
  onDelete?: (sale: Sale) => void;
}) {
  if (!sales.length) return <Empty message="Aucune vente enregistrée" detail="Vos ventes apparaîtront ici une fois saisies." />;
  return <div className="table-wrap"><table><thead><tr><th>RÉFÉRENCE</th><th>DATE</th>{!compact && <th>ARTICLES</th>}<th>MONTANT</th><th>STATUT</th>{onReceipt && <th>REÇU</th>}{(onEdit || onDelete) && <th>ACTIONS</th>}</tr></thead><tbody>{sales.map((sale) => <tr key={sale.id}><td className="mono">#{sale.id.slice(0, 7).toUpperCase()}</td><td>{dayLabel(sale.createdAt)}</td>{!compact && <td>{sale.items.reduce((sum, item) => sum + item.quantity, 0) || "—"}</td>}<td className="strong-cell">{money(sale.total, currency)}</td><td><span className="status status-ok">Terminée</span></td>{onReceipt && <td><button className="small-action" onClick={() => onReceipt(sale)}>{premium ? "Voir le reçu" : "Reçu · Premium"}</button></td>}{(onEdit || onDelete) && <td>{onEdit && <button className="small-action" onClick={() => onEdit(sale)}>Modifier</button>}{" "}{onDelete && <button className="small-action" onClick={() => onDelete(sale)}>Supprimer</button>}</td>}</tr>)}</tbody></table></div>;
}

function ExpenseTable({ expenses, currency }: { expenses: Expense[]; currency: string }) {
  if (!expenses.length) return <Empty message="Aucune dépense enregistrée" detail="Ajoutez vos dépenses pour suivre votre bénéfice net." />;
  return <div className="table-wrap"><table><thead><tr><th>LIBELLÉ</th><th>DATE</th><th>MONTANT</th></tr></thead><tbody>{expenses.map((expense) => <tr key={expense.id}><td className="strong-cell">{expense.label}</td><td>{dayLabel(expense.createdAt)}</td><td>{money(expense.amount, currency)}</td></tr>)}</tbody></table></div>;
}

function DebtTable({ debts, currency, remainingForDebt, onPayment, onEdit, onDelete }: {
  debts: CustomerDebt[];
  currency: string;
  remainingForDebt: (debt: CustomerDebt) => number;
  onPayment: (debt: CustomerDebt) => void;
  onEdit: (debt: CustomerDebt) => void;
  onDelete: (debt: CustomerDebt) => void;
}) {
  if (!debts.length) return <Empty message="Aucune dette client" detail="Les crédits clients que vous enregistrez seront listés ici." />;
  return <div className="table-wrap"><table><thead><tr><th>CLIENT</th><th>TÉLÉPHONE</th><th>NOTE</th><th>DATE</th><th>MONTANT INITIAL</th><th>RESTE DÛ</th><th>ACTIONS</th></tr></thead><tbody>{debts.map((debt) => { const remaining = remainingForDebt(debt); return <tr key={debt.id}><td className="strong-cell">{debt.customerName}</td><td>{debt.phone || "—"}</td><td>{debt.note || "—"}</td><td>{dayLabel(debt.createdAt)}</td><td>{money(debt.amount, currency)}</td><td className="debt-amount">{money(remaining, currency)}</td><td><button className="small-action" onClick={() => onPayment(debt)}>{remaining ? "Paiements" : "Voir paiements"}</button>{" "}<button className="small-action" onClick={() => onEdit(debt)}>Modifier</button>{" "}<button className="small-action" onClick={() => onDelete(debt)}>Supprimer</button></td></tr>; })}</tbody></table></div>;
}

function Empty({ message, detail }: { message: string; detail: string }) {
  return <div className="empty-state"><span>▤</span><strong>{message}</strong><small>{detail}</small></div>;
}

function ModalActions({ onCancel, submit }: { onCancel: () => void; submit: string }) {
  return <div className="modal-actions"><button type="button" className="button button-outline" onClick={onCancel}>Annuler</button><button type="submit" className="button button-primary">{submit}</button></div>;
}

function SummaryLine({ label, value, bold = false }: { label: string; value: string; bold?: boolean }) {
  return <div className={`summary-line ${bold ? "summary-total" : ""}`}><span>{label}</span><strong>{value}</strong></div>;
}

function PremiumGate({ feature, onUpgrade, accountInactive, userId, whatsappUrl, onRefresh, refreshing }: {
  feature: string;
  onUpgrade: () => void;
  accountInactive: boolean;
  userId?: string;
  whatsappUrl: string;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return <section className="locked-panel"><span className="lock-icon">✦</span><span className="eyebrow">{accountInactive ? "ACTIVATION EN ATTENTE" : "FONCTIONNALITÉ PREMIUM"}</span><h2>{accountInactive ? "Votre abonnement n’est pas encore activé." : "Débloquez ces outils pour votre boutique."}</h2><p>{feature}</p><p>{accountInactive ? "Après vérification de votre paiement, l’administrateur activera votre abonnement. L’offre gratuite reste disponible pendant l’attente." : "Premium coûte 1 000 FCFA pour un mois. Vous pouvez continuer à enregistrer vos ventes gratuitement."}</p>{accountInactive && userId && <p>UID Firebase : <code>{userId}</code></p>}{accountInactive && whatsappUrl ? <a className="button button-whatsapp" href={whatsappUrl} target="_blank" rel="noreferrer">Activer mon abonnement via WhatsApp ↗</a> : !accountInactive && <button className="button button-primary" onClick={onUpgrade}>Découvrir Premium →</button>}{accountInactive && <button className="button button-outline" onClick={onRefresh} disabled={refreshing}>{refreshing ? "Vérification…" : "Vérifier mon activation"}</button>}</section>;
}
