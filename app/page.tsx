"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  browserLocalPersistence,
  EmailAuthProvider,
  createUserWithEmailAndPassword,
  linkWithCredential,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  setPersistence,
  type User,
} from "firebase/auth";
import { auth, firebaseConfigured } from "@/lib/firebase";
import { db } from "@/lib/db";
import type { CashClosing, CashMovement, CustomerDebt, DebtPayment, Expense, PaymentMethod, Product, Purchase, Sale, Section, ShopProfile, StockLoss, Supplier, SupplierPayment } from "@/lib/models";
import { loadCloudData, loadCloudShops, saveShopProfile, syncPending } from "@/lib/sync";

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
  { id: "debts", label: "Crédits clients", icon: "◷" },
  { id: "purchases", label: "Achats fournisseurs", icon: "＋", premium: true },
  { id: "cash", label: "Caisse", icon: "▣" },
  { id: "suppliers", label: "Fournisseurs", icon: "♙", premium: true },
  { id: "losses", label: "Pertes de stock", icon: "⚠", premium: true },
  { id: "reports", label: "Bilan global", icon: "▥", premium: true },
  { id: "settings", label: "Paramètres", icon: "⚙" },
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

function isDebtOverdue(debt: CustomerDebt, remaining: number) {
  return remaining > 0 && Boolean(debt.dueDate && debt.dueDate < dateInputValue(new Date()));
}

function dayLabel(date: string) {
  return new Date(date).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}

function paymentLabel(method?: PaymentMethod) {
  if (method === "orange_money") return "Orange Money";
  if (method === "moov_money") return "Moov Money";
  if (method === "credit") return "Crédit client";
  return "Espèces";
}

function receiptText(sale: Sale, shopName: string, currency: string) {
  const itemLines = sale.items.map((item) => `${item.quantity} × ${item.productName} — ${money(item.unitPrice * item.quantity, currency)}`);
  return [
    shopName || "Ma boutique",
    `Reçu de vente #${sale.id.slice(0, 7).toUpperCase()}`,
    dayLabel(sale.createdAt),
    ...itemLines,
    `TOTAL : ${money(sale.total, currency)}`,
    `PAIEMENT : ${paymentLabel(sale.paymentMethod)}`,
    ...(sale.paymentMethod === "credit" ? [`CLIENT : ${sale.customerName ?? "Client"}`] : []),
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

function emailForPhone(phone: string) {
  return `${phone.replace(/\D/g, "")}@phone.bingi.app`;
}

function whatsappActivationUrl(uid: string, shopName: string, phone: string, premiumRequest = true) {
  const message = premiumRequest
    ? `Bonjour, je souhaite activer mon abonnement mensuel Bĩngi. Mon identifiant de compte est : ${uid}. Boutique : ${shopName || "Ma boutique"}. Numéro de téléphone : ${phone}.`
    : `Bonjour, je viens de créer mon compte Bĩngi. Mon identifiant de compte est : ${uid}. Boutique : ${shopName || "Ma boutique"}. Numéro de téléphone : ${phone}.`;
  return `https://wa.me/message/SQXBCLHS6SBXN1?text=${encodeURIComponent(message)}`;
}

function isActivePremium(shop: ShopProfile | null) {
  if (!shop || shop.estActif !== true) return false;
  return !shop.subscriptionExpiresAt || new Date(shop.subscriptionExpiresAt).getTime() > Date.now();
}

function cachedShopProfile(uid: string): ShopProfile | null {
  try {
    const value = localStorage.getItem(`zambo-shop-profile:${uid}`);
    if (!value) return null;
    const profile = JSON.parse(value) as ShopProfile;
    return profile.ownerUid === uid ? profile : null;
  } catch { return null; }
}

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authGatePassed, setAuthGatePassed] = useState(false);
  const authGatePassedRef = useRef(false);
  const [ownerUid, setOwnerUid] = useState("");
  const [phone, setPhone] = useState("");
  const [accountPassword, setAccountPassword] = useState("");
  const [authMode, setAuthMode] = useState<"register" | "login">("register");
  const [authBusy, setAuthBusy] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  const [section, setSection] = useState<Section>("dashboard");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [shopName, setShopName] = useState("");
  const [currency, setCurrency] = useState(CURRENCY);
  const [shop, setShop] = useState<ShopProfile | null>(null);
  const [shops, setShops] = useState<ShopProfile[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [debts, setDebts] = useState<CustomerDebt[]>([]);
  const [debtPayments, setDebtPayments] = useState<DebtPayment[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [stockLosses, setStockLosses] = useState<StockLoss[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [supplierPayments, setSupplierPayments] = useState<SupplierPayment[]>([]);
  const [cashMovements, setCashMovements] = useState<CashMovement[]>([]);
  const [cashClosings, setCashClosings] = useState<CashClosing[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("Hors ligne prêt");
  const [toast, setToast] = useState<Toast>(null);
  const [modal, setModal] = useState<"product" | "sale" | "expense" | "debt" | "debt-payment" | "debt-payment-edit" | "receipt" | "premium" | "cloud-sync" | "supplier" | "restock" | "loss" | "supplier-payment" | null>(null);
  const [selectedReceipt, setSelectedReceipt] = useState<Sale | null>(null);
  const [selectedDebt, setSelectedDebt] = useState<CustomerDebt | null>(null);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [editingSale, setEditingSale] = useState<Sale | null>(null);
  const [editingDebt, setEditingDebt] = useState<CustomerDebt | null>(null);
  const [editingDebtPayment, setEditingDebtPayment] = useState<DebtPayment | null>(null);
  const [stockProduct, setStockProduct] = useState<Product | null>(null);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);
  const [supplierName, setSupplierName] = useState("");
  const [supplierPhone, setSupplierPhone] = useState("");
  const [supplierNote, setSupplierNote] = useState("");
  const [restockQuantity, setRestockQuantity] = useState("1");
  const [restockCost, setRestockCost] = useState("");
  const [restockSupplierId, setRestockSupplierId] = useState("");
  const [restockPaid, setRestockPaid] = useState("");
  const [restockMethod, setRestockMethod] = useState<Exclude<PaymentMethod, "credit">>("cash");
  const [selectedPurchase, setSelectedPurchase] = useState<Purchase | null>(null);
  const [supplierPaymentAmount, setSupplierPaymentAmount] = useState("");
  const [supplierPaymentMethod, setSupplierPaymentMethod] = useState<Exclude<PaymentMethod, "credit">>("cash");
  const [salePaymentMethod, setSalePaymentMethod] = useState<PaymentMethod>("cash");
  const [saleCustomerName, setSaleCustomerName] = useState("");
  const [saleCustomerPhone, setSaleCustomerPhone] = useState("");
  const [expenseMethod, setExpenseMethod] = useState<Exclude<PaymentMethod, "credit">>("cash");
  const [debtPaymentMethod, setDebtPaymentMethod] = useState<Exclude<PaymentMethod, "credit">>("cash");
  const [cashDate, setCashDate] = useState(() => dateInputValue(new Date()));
  const [cashOpening, setCashOpening] = useState("0");
  const [cashCounted, setCashCounted] = useState("");
  const [cashCloseNote, setCashCloseNote] = useState("");
  const [cashMovementKind, setCashMovementKind] = useState<"deposit" | "withdrawal">("withdrawal");
  const [cashMovementAmount, setCashMovementAmount] = useState("");
  const [cashMovementMethod, setCashMovementMethod] = useState<Exclude<PaymentMethod, "credit">>("cash");
  const [cashMovementNote, setCashMovementNote] = useState("");
  const [lossQuantity, setLossQuantity] = useState("1");
  const [lossReason, setLossReason] = useState("");
  const [debtDueDate, setDebtDueDate] = useState(() => { const date = new Date(); date.setDate(date.getDate() + 30); return dateInputValue(date); });
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
  const [reportPeriod, setReportPeriod] = useState<"day" | "month" | "all">("day");
  const [reportMonth, setReportMonth] = useState(() => dateInputValue(new Date()).slice(0, 7));
  const [installPrompt, setInstallPrompt] = useState<Event | null>(null);
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
  const paidBySupplierPurchase = useMemo(() => supplierPayments.reduce((totals, payment) => {
    if (!payment.isDeleted) totals.set(payment.purchaseId, (totals.get(payment.purchaseId) ?? 0) + payment.amount);
    return totals;
  }, new Map<string, number>()), [supplierPayments]);
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
    const [nextProducts, nextSales, nextExpenses, nextDebtsRaw, nextDebtPayments, nextSuppliersRaw, nextLossesRaw, nextPurchasesRaw, nextSupplierPaymentsRaw, nextCashMovementsRaw, nextCashClosingsRaw] = await Promise.all([
      db.products.where("ownerUid").equals(uid).toArray(),
      db.sales.where("ownerUid").equals(uid).toArray(),
      db.expenses.where("ownerUid").equals(uid).toArray(),
      db.debts.where("ownerUid").equals(uid).toArray(),
      db.debtPayments.where("ownerUid").equals(uid).toArray(),
      db.suppliers.where("ownerUid").equals(uid).toArray(),
      db.stockLosses.where("ownerUid").equals(uid).toArray(),
      db.purchases.where("ownerUid").equals(uid).toArray(),
      db.supplierPayments.where("ownerUid").equals(uid).toArray(),
      db.cashMovements.where("ownerUid").equals(uid).toArray(),
      db.cashClosings.where("ownerUid").equals(uid).toArray(),
    ]);
    const visibleProducts = nextProducts.filter((item) => !item.isDeleted);
    const visibleSales = nextSales.filter((item) => !item.isDeleted);
    const visibleDebts = nextDebtsRaw.filter((item) => !item.isDeleted);
    const visiblePayments = nextDebtPayments.filter((item) => !item.isDeleted);
    const visibleSuppliers = nextSuppliersRaw.filter((item) => !item.isDeleted);
    const visibleLosses = nextLossesRaw.filter((item) => !item.isDeleted);
    const visiblePurchases = nextPurchasesRaw.filter((item) => !item.isDeleted);
    const visibleSupplierPayments = nextSupplierPaymentsRaw.filter((item) => !item.isDeleted);
    const visibleCashMovements = nextCashMovementsRaw.filter((item) => !item.isDeleted);
    const visibleCashClosings = nextCashClosingsRaw;
    visibleProducts.sort((a, b) => a.name.localeCompare(b.name));
    visibleSales.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const visibleExpenses = nextExpenses.filter((item) => !item.isDeleted);
    visibleExpenses.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    visibleDebts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    visiblePayments.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    visibleLosses.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    visiblePurchases.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    visibleSupplierPayments.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    visibleCashMovements.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    setProducts(visibleProducts);
    setSales(visibleSales);
    setExpenses(visibleExpenses);
    setDebts(visibleDebts);
    setDebtPayments(visiblePayments);
    setSuppliers(visibleSuppliers);
    setStockLosses(visibleLosses);
    setPurchases(visiblePurchases);
    setSupplierPayments(visibleSupplierPayments);
    setCashMovements(visibleCashMovements);
    setCashClosings(visibleCashClosings);
  }, [ownerUid]);

  const synchronize = useCallback(async (uid = ownerUid) => {
    if (!uid || !user || !navigator.onLine || migratingRef.current || !authGatePassedRef.current) return;
    setSyncing(true);
    try {
      const profilePendingKey = `zambo-shop-pending:${uid}`;
      if (localStorage.getItem(profilePendingKey) === "true") {
        await saveShopProfile(uid, {
          name: localStorage.getItem(`zambo-shop-name:${uid}`) || "Ma boutique",
          currency: localStorage.getItem(`zambo-currency:${uid}`) || CURRENCY,
          phone: localStorage.getItem(`zambo-shop-phone:${uid}`) || undefined,
        });
        localStorage.removeItem(profilePendingKey);
      }
      let initialCloud = await loadCloudData(uid);
      if (!initialCloud.shop) {
        await saveShopProfile(uid, {
          name: localStorage.getItem(`zambo-shop-name:${uid}`) || "Ma boutique",
          currency: localStorage.getItem(`zambo-currency:${uid}`) || CURRENCY,
          phone: localStorage.getItem(`zambo-shop-phone:${uid}`) || undefined,
        });
        initialCloud = await loadCloudData(uid);
      }
      if (initialCloud.shop) {
        setShop(initialCloud.shop);
        localStorage.setItem(`zambo-shop-profile:${uid}`, JSON.stringify(initialCloud.shop));
      }
      const counts = await syncPending(uid, isActivePremium(initialCloud.shop));
      const cloudShop = await loadCloudData(uid);
      if (cloudShop.shop) {
        const savedShop = cloudShop.shop;
        setShop(savedShop);
        localStorage.setItem(`zambo-shop-profile:${uid}`, JSON.stringify(savedShop));
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
  }, [notify, ownerUid, refreshLocal, user]);

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
    const localProfile = { ownerUid: localUid, name: localName, currency: localCurrency, subscriptionStatus: "FREE" as const };
    setShop(localProfile);
    setShops([localProfile]);
    setShopName(localName);
    setCurrency(localCurrency);

    if (!auth) {
      setAuthReady(true);
      return () => { cancelled = true; };
    }
    return onAuthStateChanged(auth, async (nextUser) => {
      if (cancelled) return;
      setAuthReady(true);
      setUser(nextUser);
      if (nextUser) {
        setAuthMode(nextUser.isAnonymous ? "register" : "login");
        if (!nextUser.isAnonymous) {
          setAuthGatePassed(true);
          authGatePassedRef.current = true;
        }
        const emailDigits = nextUser.email?.match(/^(\d{10,15})@phone\.bingi\.app$/)?.[1];
        setPhone(localStorage.getItem(`zambo-shop-phone:${nextUser.uid}`) || (emailDigits ? `+${emailDigits}` : ""));
        if (nextUser.isAnonymous) {
          setAuthGatePassed(false);
          authGatePassedRef.current = false;
        }
      } else {
        setAuthGatePassed(false);
        authGatePassedRef.current = false;
      }
      if (!nextUser) {
        setShop((current) => current ? { ...current, subscriptionStatus: "FREE", subscriptionExpiresAt: null } : current);
        return;
      }
      const activeShopKey = localStorage.getItem(`zambo-active-shop:${nextUser.uid}`) || nextUser.uid;
      setOwnerUid(activeShopKey);
      if (migratingRef.current || !authGatePassedRef.current) return;
      const cachedProfile = cachedShopProfile(activeShopKey);
      try {
        const cachedShops = JSON.parse(localStorage.getItem(`zambo-shops:${nextUser.uid}`) || "[]") as ShopProfile[];
        if (cachedShops.length) setShops(cachedShops);
      } catch { setShops([]); }
      if (cachedProfile) {
        setShop(cachedProfile);
        setShopName(cachedProfile.name);
        setCurrency(cachedProfile.currency);
      }
      setLoading(true);
      try {
        const cloudShop = await loadCloudData(activeShopKey);
        const [rootCloud, remoteShops] = await Promise.all([loadCloudData(nextUser.uid), loadCloudShops(nextUser.uid)]);
        const allShops = [rootCloud.shop, ...remoteShops].filter((item): item is ShopProfile => Boolean(item)).map((item) => ({ ...item, estActif: rootCloud.shop?.estActif ?? item.estActif, subscriptionExpiresAt: rootCloud.shop?.subscriptionExpiresAt ?? item.subscriptionExpiresAt }));
        if (allShops.length) {
          setShops(allShops);
          localStorage.setItem(`zambo-shops:${nextUser.uid}`, JSON.stringify(allShops));
        }
        if (cloudShop.shop) {
          const savedShop = cloudShop.shop;
          setShop(savedShop);
          localStorage.setItem(`zambo-shop-profile:${activeShopKey}`, JSON.stringify(savedShop));
          setShopName(savedShop.name);
          setCurrency(savedShop.currency);
          localStorage.setItem(`zambo-shop-name:${activeShopKey}`, savedShop.name);
          localStorage.setItem(`zambo-currency:${activeShopKey}`, savedShop.currency);
        } else {
          const savedName = localStorage.getItem(`zambo-shop-name:${activeShopKey}`) || "Ma boutique";
          const savedCurrency = localStorage.getItem(`zambo-currency:${activeShopKey}`) || CURRENCY;
          setShop({ ownerUid: activeShopKey, name: savedName, currency: savedCurrency, subscriptionStatus: "FREE" });
          setShopName(savedName);
          setCurrency(savedCurrency);
          localStorage.setItem(`zambo-shop-pending:${activeShopKey}`, "true");
        }
        setSyncMessage("Synchronisé");
      } catch (error) {
        console.error("Could not load Firebase Firestore data", error);
        setSyncMessage("Données locales disponibles");
        notify("error", "La synchronisation en ligne a échoué. Les données enregistrées sur cet appareil restent accessibles.");
      } finally {
        if (!cancelled) {
          await refreshLocal(activeShopKey);
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
    if (user && ownerUid.startsWith(user.uid)) void synchronize(ownerUid);
  }, [ownerUid, synchronize, user]);

  useEffect(() => {
    if (!user) return;
    const online = () => void synchronize(ownerUid);
    const visible = () => {
      if (document.visibilityState === "visible") void synchronize(ownerUid);
    };
    const focused = () => void synchronize(ownerUid);
    window.addEventListener("online", online);
    window.addEventListener("focus", focused);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("focus", focused);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [ownerUid, synchronize, user]);

  useEffect(() => {
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js");
    const capture = (event: Event) => { event.preventDefault(); setInstallPrompt(event); };
    const installed = () => setInstallPrompt(null);
    window.addEventListener("beforeinstallprompt", capture);
    window.addEventListener("appinstalled", installed);
    return () => {
      window.removeEventListener("beforeinstallprompt", capture);
      window.removeEventListener("appinstalled", installed);
    };
  }, []);

  async function installApp() {
    if (installPrompt && "prompt" in installPrompt) {
      await (installPrompt as Event & { prompt: () => Promise<void> }).prompt();
      setInstallPrompt(null);
    } else notify("success", "Sur iPhone : touchez Partager, puis « Sur l’écran d’accueil ». Sur Android, ouvrez le menu ⋮ puis Installer l’application.");
  }

  async function attachLocalDataToAccount(targetUid: string, sourceUid: string) {
    if (!sourceUid || sourceUid === targetUid || !sourceUid.startsWith("local-")) return;
    await db.transaction("rw", [db.products, db.sales, db.expenses, db.debts, db.debtPayments, db.suppliers, db.stockLosses, db.purchases, db.supplierPayments, db.cashMovements, db.cashClosings], async () => {
      const [localProducts, localSales, localExpenses, localDebts, localPayments, localSuppliers, localLosses, localPurchases, localSupplierPayments, localCashMovements, localCashClosings] = await Promise.all([
        db.products.where("ownerUid").equals(sourceUid).toArray(),
        db.sales.where("ownerUid").equals(sourceUid).toArray(),
        db.expenses.where("ownerUid").equals(sourceUid).toArray(),
        db.debts.where("ownerUid").equals(sourceUid).toArray(),
        db.debtPayments.where("ownerUid").equals(sourceUid).toArray(),
        db.suppliers.where("ownerUid").equals(sourceUid).toArray(),
        db.stockLosses.where("ownerUid").equals(sourceUid).toArray(),
        db.purchases.where("ownerUid").equals(sourceUid).toArray(),
        db.supplierPayments.where("ownerUid").equals(sourceUid).toArray(),
        db.cashMovements.where("ownerUid").equals(sourceUid).toArray(),
        db.cashClosings.where("ownerUid").equals(sourceUid).toArray(),
      ]);
      for (const item of localProducts) await db.products.put({ ...item, ownerUid: targetUid, synced: false });
      for (const item of localSales) await db.sales.put({ ...item, ownerUid: targetUid, synced: false });
      for (const item of localExpenses) await db.expenses.put({ ...item, ownerUid: targetUid, synced: false });
      for (const item of localDebts) await db.debts.put({ ...item, ownerUid: targetUid, synced: false });
      for (const item of localPayments) await db.debtPayments.put({ ...item, ownerUid: targetUid, synced: false });
      for (const item of localSuppliers) await db.suppliers.put({ ...item, ownerUid: targetUid, synced: false });
      for (const item of localLosses) await db.stockLosses.put({ ...item, ownerUid: targetUid, synced: false });
      for (const item of localPurchases) await db.purchases.put({ ...item, ownerUid: targetUid, synced: false });
      for (const item of localSupplierPayments) await db.supplierPayments.put({ ...item, ownerUid: targetUid, synced: false });
      for (const item of localCashMovements) await db.cashMovements.put({ ...item, ownerUid: targetUid, synced: false });
      for (const item of localCashClosings) await db.cashClosings.put({ ...item, ownerUid: targetUid, synced: false });
    });
    localStorage.setItem(`zambo-shop-name:${targetUid}`, shopName || "Ma boutique");
    localStorage.setItem(`zambo-currency:${targetUid}`, currency || CURRENCY);
    localStorage.setItem(`zambo-shop-pending:${targetUid}`, "true");
  }

  async function createAccountWithoutSms() {
    const currentAuth = auth;
    const normalizedPhone = normalizeBurkinaPhone(phone);
    if (!currentAuth) return setAuthMessage("La création de compte n’est pas disponible pour le moment.");
    if (!normalizedPhone) return setAuthMessage("Saisissez un numéro valide avec l’indicatif +226, par exemple +226 70 00 00 00.");
    if (!/^\d{6,12}$/.test(accountPassword)) return setAuthMessage("Le code secret doit contenir de 6 à 12 chiffres.");
    setPhone(normalizedPhone);
    setAuthBusy(true);
    setMigrationBusy(true);
    migratingRef.current = true;
    setAuthMessage("");
    try {
      await setPersistence(currentAuth, browserLocalPersistence);
      const sourceUid = ownerUid;
      const email = emailForPhone(normalizedPhone);
      const credential = authMode === "login"
        ? await signInWithEmailAndPassword(currentAuth, email, accountPassword)
        : currentAuth.currentUser?.isAnonymous
          ? await linkWithCredential(currentAuth.currentUser, EmailAuthProvider.credential(email, accountPassword))
          : await createUserWithEmailAndPassword(currentAuth, email, accountPassword);
      const targetUid = credential.user.uid;
      const pendingName = localStorage.getItem(`zambo-shop-name:${targetUid}`) || shopName || "Ma boutique";
      const pendingCurrency = localStorage.getItem(`zambo-currency:${targetUid}`) || currency || CURRENCY;
      localStorage.setItem(`zambo-shop-phone:${targetUid}`, normalizedPhone);
      await saveShopProfile(targetUid, { name: pendingName, currency: pendingCurrency, phone: normalizedPhone });
      localStorage.removeItem(`zambo-shop-pending:${targetUid}`);
      await attachLocalDataToAccount(targetUid, sourceUid);
      localStorage.removeItem(`zambo-shop-pending:${targetUid}`);
      const cloudShop = await loadCloudData(targetUid);
      if (cloudShop.shop) {
        const remoteShops = await loadCloudShops(targetUid);
        const allShops = [cloudShop.shop, ...remoteShops];
        setShop(cloudShop.shop); setShops(allShops);
        localStorage.setItem(`zambo-shops:${targetUid}`, JSON.stringify(allShops));
        localStorage.setItem(`zambo-active-shop:${targetUid}`, targetUid);
        localStorage.setItem(`zambo-shop-profile:${targetUid}`, JSON.stringify(cloudShop.shop));
      }
      setOwnerUid(targetUid);
      setUser(credential.user);
      setAccountPassword("");
      setAuthGatePassed(true);
      authGatePassedRef.current = true;
      await syncPending(targetUid, isActivePremium(cloudShop.shop));
      await refreshLocal(targetUid);
      setAuthMessage(modal === "cloud-sync" || modal === null
        ? authMode === "login" ? "Connexion réussie. Vos données sont synchronisées en ligne." : "Compte créé. Vos données sont synchronisées en ligne."
        : authMode === "login" ? "Connexion réussie. Vous pouvez envoyer votre demande Premium sur WhatsApp." : "Compte créé. Votre abonnement attend son activation via WhatsApp.");
      notify("success", modal === "cloud-sync" || modal === null
        ? authMode === "login" ? "Connexion réussie et données synchronisées." : "Compte créé et données synchronisées."
        : authMode === "login" ? "Connexion réussie." : "Compte créé. Envoyez votre UID sur WhatsApp pour demander l’activation Premium.");
      if (modal === "premium") {
        window.location.assign(whatsappActivationUrl(targetUid, pendingName, normalizedPhone));
      }
    } catch (error) {
      console.error("Firebase phone/code authentication failed", error);
      const code = (error as { code?: string })?.code;
      setAuthMessage(code === "auth/email-already-in-use"
        ? "Ce numéro a déjà un compte. Choisissez « Me connecter » pour ouvrir votre compte."
        : code === "auth/invalid-credential" || code === "auth/invalid-login-credentials" || code === "auth/user-not-found" || code === "auth/wrong-password"
          ? "Numéro ou code incorrect."
          : code === "auth/weak-password"
            ? "Choisissez un code d’au moins 6 chiffres."
            : code === "auth/operation-not-allowed"
              ? "La création de compte est momentanément indisponible. Réessayez plus tard."
              : "Impossible de créer le compte ou d’enregistrer vos données. Vérifiez votre connexion et réessayez.");
    } finally {
      migratingRef.current = false;
      setMigrationBusy(false);
      setAuthBusy(false);
    }
  }

  function openPremiumRequest() {
    setPhone(user?.phoneNumber ?? shop?.phone ?? "");
    setAccountPassword("");
    setAuthMode("register");
    setAuthMessage("");
    setModal("premium");
  }

  function openCloudSync() {
    setPhone(user?.phoneNumber ?? shop?.phone ?? "");
    setAccountPassword("");
    setAuthMode("register");
    setAuthMessage("");
    setModal("cloud-sync");
  }

  async function saveShopSettings() {
    const name = shopName.trim();
    if (!name) return notify("error", "Saisissez le nom de votre boutique.");
    setShop({ ...(shop ?? { ownerUid, subscriptionStatus: "FREE" }), name, currency });
    const updatedShop = { ...(shop ?? { ownerUid, subscriptionStatus: "FREE" as const }), name, currency };
    const updatedShops = shops.some((item) => item.ownerUid === ownerUid)
      ? shops.map((item) => item.ownerUid === ownerUid ? { ...item, name, currency } : item)
      : [...shops, updatedShop];
    setShops(updatedShops);
    if (user) localStorage.setItem(`zambo-shops:${user.uid}`, JSON.stringify(updatedShops));
    localStorage.setItem(`zambo-shop-profile:${ownerUid}`, JSON.stringify(updatedShop));
    localStorage.setItem(`zambo-shop-name:${ownerUid}`, name);
    localStorage.setItem(`zambo-currency:${ownerUid}`, currency);
    if (user && navigator.onLine) {
      setSyncing(true);
      try {
        await saveShopProfile(ownerUid, { name, currency });
        const response = await loadCloudData(ownerUid);
        const savedProfile = response.shop ?? updatedShop;
        const confirmedProfile = { ...savedProfile, name, currency };
        setShop(confirmedProfile);
        setShops((current) => current.some((item) => item.ownerUid === ownerUid)
          ? current.map((item) => item.ownerUid === ownerUid ? { ...item, name, currency } : item)
          : [...current, confirmedProfile]);
        localStorage.setItem(`zambo-shop-profile:${ownerUid}`, JSON.stringify(confirmedProfile));
        localStorage.setItem(`zambo-shops:${user.uid}`, JSON.stringify(updatedShops));
        localStorage.removeItem(`zambo-shop-pending:${ownerUid}`);
        setSyncMessage("Nom synchronisé en ligne");
      } catch (error) {
        console.error("Could not save shop profile", error);
        localStorage.setItem(`zambo-shop-pending:${ownerUid}`, "true");
        setSyncMessage("Synchronisation du nom en attente");
        const code = (error as { code?: string })?.code;
        notify("error", code === "permission-denied"
          ? "Le serveur refuse l’écriture du profil. Les règles de sécurité en ligne doivent autoriser la modification du nom."
          : "Le nom est gardé sur cet appareil, mais la sauvegarde en ligne a échoué. Vérifiez la connexion puis réessayez.");
        return;
      } finally {
        setSyncing(false);
      }
    } else if (user) {
      localStorage.setItem(`zambo-shop-pending:${ownerUid}`, "true");
    }
    notify("success", "Paramètres de la boutique enregistrés.");
  }

  async function createBoutique() {
    if (!user || !premium) return openPremiumRequest();
    if (shops.length >= 3) return notify("error", "Premium autorise jusqu’à 3 boutiques au total.");
    const shopId = newId();
    const key = `${user.uid}::${shopId}`;
    const newShop: ShopProfile = { ownerUid: key, shopId, name: `Boutique ${shops.length + 1}`, currency, subscriptionStatus: "PREMIUM", estActif: shop?.estActif, subscriptionExpiresAt: shop?.subscriptionExpiresAt };
    const nextShops = [...shops, newShop];
    setShops(nextShops); setShop(newShop); setShopName(newShop.name); setOwnerUid(key);
    localStorage.setItem(`zambo-active-shop:${user.uid}`, key);
    localStorage.setItem(`zambo-shops:${user.uid}`, JSON.stringify(nextShops));
    localStorage.setItem(`zambo-shop-profile:${key}`, JSON.stringify(newShop));
    localStorage.setItem(`zambo-shop-name:${key}`, newShop.name); localStorage.setItem(`zambo-currency:${key}`, currency);
    try {
      if (navigator.onLine) await saveShopProfile(key, { name: newShop.name, currency });
      else localStorage.setItem(`zambo-shop-pending:${key}`, "true");
      await refreshLocal(key);
      if (navigator.onLine) void synchronize(key);
      notify("success", "Nouvelle boutique créée. Son stock et ses ventes sont séparés.");
    } catch (error) { console.error("Boutique could not be created online", error); localStorage.setItem(`zambo-shop-pending:${key}`, "true"); notify("error", "Boutique créée sur cet appareil ; sa création en ligne sera réessayée à la prochaine connexion."); }
  }

  async function switchBoutique(key: string) {
    const selected = shops.find((item) => item.ownerUid === key);
    if (!selected || !user) return;
    setOwnerUid(key); setShop(selected); setShopName(selected.name); setCurrency(selected.currency);
    localStorage.setItem(`zambo-active-shop:${user.uid}`, key);
    localStorage.setItem(`zambo-shop-profile:${key}`, JSON.stringify(selected));
    await refreshLocal(key);
    if (navigator.onLine) void synchronize(key);
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

  async function addSupplier(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supplierName.trim()) return notify("error", "Saisissez le nom du fournisseur.");
    const supplier: Supplier = { ...(editingSupplier ?? { id: newId(), ownerUid }), name: supplierName.trim(), phone: supplierPhone.trim(), note: supplierNote.trim(), synced: false };
    if (editingSupplier) await db.suppliers.put(supplier); else await db.suppliers.add(supplier);
    setEditingSupplier(null);
    setSupplierName(""); setSupplierPhone(""); setSupplierNote(""); setModal(null);
    await refreshLocal(); notify("success", "Fournisseur enregistré."); void synchronize();
  }

  function openSupplierEditor(supplier: Supplier) {
    if (!premium) return openPremiumRequest();
    setEditingSupplier(supplier); setSupplierName(supplier.name); setSupplierPhone(supplier.phone); setSupplierNote(supplier.note); setModal("supplier");
  }

  async function deleteSupplier(supplier: Supplier) {
    if (!window.confirm(`Supprimer le fournisseur « ${supplier.name} » ?`)) return;
    await db.suppliers.put({ ...supplier, isDeleted: true, synced: false });
    await refreshLocal(); notify("success", "Fournisseur supprimé."); void synchronize();
  }

  function openRestock(product: Product) {
    if (!premium) return openPremiumRequest();
    setStockProduct(product); setRestockQuantity("1"); setRestockCost(String(product.costPrice)); setRestockSupplierId(""); setRestockPaid(""); setRestockMethod("cash"); setModal("restock");
  }

  async function receiveStock(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const product = stockProduct;
    const quantity = Number(restockQuantity);
    const cost = Number(restockCost);
    if (!product || !Number.isInteger(quantity) || quantity < 1 || !Number.isInteger(cost) || cost < 0) return notify("error", "Vérifiez la quantité et le prix d’achat.");
    const supplier = suppliers.find((item) => item.id === restockSupplierId);
    const total = quantity * cost;
    const amountPaid = restockPaid === "" ? total : Number(restockPaid);
    if (!Number.isInteger(amountPaid) || amountPaid < 0 || amountPaid > total) return notify("error", "Le montant payé doit être compris entre 0 et le total de l’achat.");
    const purchase: Purchase = { id: newId(), ownerUid, productId: product.id, productName: product.name, supplierId: supplier?.id, supplierName: supplier?.name ?? "Non précisé", quantity, unitCost: cost, total, amountPaid, paymentMethod: restockMethod, createdAt: new Date().toISOString(), synced: false };
    const nextStock = product.stock + quantity;
    const weightedCost = nextStock > 0 ? Math.round((product.stock * product.costPrice + quantity * cost) / nextStock) : cost;
    await db.transaction("rw", db.products, db.purchases, async () => {
      await db.products.put({ ...product, stock: nextStock, costPrice: weightedCost, supplierId: supplier?.id, supplierName: supplier?.name, updatedAt: new Date().toISOString(), synced: false });
      await db.purchases.add(purchase);
    });
    setModal(null); setStockProduct(null); await refreshLocal(); notify("success", `Achat enregistré : ${quantity} unité(s) de ${product.name}.`); void synchronize();
  }

  async function addSupplierPayment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const purchase = selectedPurchase;
    const amount = Number(supplierPaymentAmount);
    const alreadyPaid = purchase ? purchase.amountPaid + supplierPayments.filter((payment) => payment.purchaseId === purchase.id).reduce((sum, payment) => sum + payment.amount, 0) : 0;
    if (!purchase || !Number.isInteger(amount) || amount <= 0 || amount > purchase.total - alreadyPaid) return notify("error", "Saisissez un paiement valide, inférieur ou égal au reste dû.");
    const payment: SupplierPayment = { id: newId(), ownerUid, purchaseId: purchase.id, amount, paymentMethod: supplierPaymentMethod, createdAt: new Date().toISOString(), synced: false };
    await db.supplierPayments.add(payment);
    setSelectedPurchase(null); setSupplierPaymentAmount(""); setModal(null);
    await refreshLocal(); notify("success", "Règlement fournisseur enregistré."); void synchronize();
  }

  function openLoss(product: Product) { if (!premium) return openPremiumRequest(); setStockProduct(product); setLossQuantity("1"); setLossReason(""); setModal("loss"); }

  async function recordStockLoss(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const product = stockProduct;
    const quantity = Number(lossQuantity);
    if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > product.stock || !lossReason.trim()) return notify("error", "Indiquez une quantité disponible et le motif de la perte.");
    const loss: StockLoss = { id: newId(), ownerUid, productId: product.id, productName: product.name, quantity, unitCost: product.costPrice, reason: lossReason.trim(), createdAt: new Date().toISOString(), synced: false };
    await db.transaction("rw", db.products, db.stockLosses, async () => {
      await db.products.put({ ...product, stock: product.stock - quantity, updatedAt: new Date().toISOString(), synced: false });
      await db.stockLosses.add(loss);
    });
    setModal(null); setStockProduct(null); await refreshLocal(); notify("success", "Perte de stock enregistrée et quantité ajustée."); void synchronize();
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
    if (!editingSale && salePaymentMethod === "credit" && !saleCustomerName.trim()) return notify("error", "Indiquez le nom du client pour enregistrer la vente à crédit.");
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
      paymentMethod: salePaymentMethod,
      amountPaid: salePaymentMethod === "credit" ? 0 : product.sellingPrice * quantity,
      ...(salePaymentMethod === "credit" ? { customerName: saleCustomerName.trim(), customerPhone: saleCustomerPhone.trim() } : {}),
      synced: false,
    };
    try {
      await db.transaction("rw", db.products, db.sales, db.debts, async () => {
        const currentProduct = await db.products.get(product.id);
        if (!currentProduct || currentProduct.stock < quantity) throw new Error("Insufficient stock");
        await db.products.update(product.id, {
          stock: currentProduct.stock - quantity,
          updatedAt: new Date().toISOString(),
          synced: false,
        });
        await db.sales.add(sale);
        if (salePaymentMethod === "credit") {
          await db.debts.add({ id: newId(), ownerUid, saleId, customerName: saleCustomerName.trim(), phone: saleCustomerPhone.trim(), amount: sale.total, note: `Vente #${saleId.slice(0, 7).toUpperCase()}`, isPaid: false, dueDate: debtDueDate || undefined, createdAt: sale.createdAt, synced: false });
        }
      });
    } catch (error) {
      console.error("Sale could not be recorded", error);
      return notify("error", "Stock insuffisant ou vente impossible. Vérifiez le stock puis réessayez.");
    }
    setModal(null);
    setSaleProductId("");
    setSaleQuantity("1");
    setSalePaymentMethod("cash"); setSaleCustomerName(""); setSaleCustomerPhone("");
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
      await db.transaction("rw", db.products, db.sales, db.debts, db.debtPayments, async () => {
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
        const linkedDebt = await db.debts.where("saleId").equals(currentSale.id).first();
        if (linkedDebt) {
          const linkedPayments = await db.debtPayments.where("debtId").equals(linkedDebt.id).toArray();
          const paidAmount = linkedPayments.filter((payment) => !payment.isDeleted).reduce((sum, payment) => sum + payment.amount, 0);
          const updatedTotal = product.sellingPrice * quantity;
          if (updatedTotal < paidAmount) throw new Error("Sale total is below paid debt amount");
          await db.debts.put({ ...linkedDebt, amount: updatedTotal, isPaid: updatedTotal <= paidAmount, synced: false });
        }
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
    setSalePaymentMethod(sale.paymentMethod ?? "cash");
    setSaleCustomerName(sale.customerName ?? "");
    setSaleCustomerPhone(sale.customerPhone ?? "");
    setModal("sale");
  }

  async function deleteSale(sale: Sale) {
    if (!window.confirm("Supprimer cette vente ? Les quantités vendues seront remises en stock.")) return;
    try {
      await db.transaction("rw", db.products, db.sales, db.debts, db.debtPayments, async () => {
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
        const linkedDebts = await db.debts.where("saleId").equals(currentSale.id).toArray();
        for (const debt of linkedDebts) {
          const payments = await db.debtPayments.where("debtId").equals(debt.id).toArray();
          for (const payment of payments) await db.debtPayments.put({ ...payment, isDeleted: true, synced: false });
          await db.debts.put({ ...debt, isDeleted: true, synced: false });
        }
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
    const expense: Expense = editingExpense
      ? { ...editingExpense, label: expenseLabel.trim(), amount, paymentMethod: expenseMethod, synced: false }
      : { id: newId(), ownerUid, label: expenseLabel.trim(), amount, paymentMethod: expenseMethod, createdAt: new Date().toISOString(), synced: false };
    if (editingExpense) await db.expenses.put(expense); else await db.expenses.add(expense);
    setModal(null);
    setEditingExpense(null);
    setExpenseLabel("");
    setExpenseAmount("");
    await refreshLocal();
    notify("success", editingExpense ? "Dépense modifiée." : "Dépense enregistrée.");
    void synchronize();
  }

  function openExpenseEditor(expense: Expense) { setEditingExpense(expense); setExpenseLabel(expense.label); setExpenseAmount(String(expense.amount)); setExpenseMethod(expense.paymentMethod ?? "cash"); setModal("expense"); }

  async function deleteExpense(expense: Expense) {
    if (!window.confirm(`Supprimer la dépense « ${expense.label} » ?`)) return;
    await db.expenses.put({ ...expense, isDeleted: true, synced: false });
    await refreshLocal(); notify("success", "Dépense supprimée."); void synchronize();
  }

  async function addDebt(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
          dueDate: debtDueDate || undefined,
          isPaid: amount <= (paidByDebt.get(editingDebt.id) ?? 0),
          synced: false,
        }
      : {
          id: newId(), ownerUid, customerName: debtName.trim(), phone: debtPhone.trim(), amount,
          note: debtNote.trim(), isPaid: false, createdAt: new Date().toISOString(), synced: false,
          dueDate: debtDueDate || undefined,
        };
    if (editingDebt) await db.debts.put(debt);
    else await db.debts.add(debt);
    setModal(null);
    setEditingDebt(null);
    setDebtName("");
    setDebtPhone("");
    setDebtAmount("");
    setDebtNote("");
    setDebtDueDate(() => { const date = new Date(); date.setDate(date.getDate() + 30); return dateInputValue(date); });
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
    setDebtDueDate(debt.dueDate ?? "");
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
    const debt = selectedDebt;
    const amount = Number(debtPaymentAmount);
    if (!debt || !Number.isInteger(amount) || amount <= 0) {
      return notify("error", "Saisissez un montant de paiement valide.");
    }

    async function updateDebtPayment(event: React.FormEvent<HTMLFormElement>) {
      event.preventDefault();
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
      paymentMethod: debtPaymentMethod,
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

  async function addCashMovement(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amount = Number(cashMovementAmount);
    if (!Number.isInteger(amount) || amount <= 0 || !cashMovementNote.trim()) return notify("error", "Indiquez un montant et le motif du mouvement.");
    const movement: CashMovement = { id: newId(), ownerUid, kind: cashMovementKind, amount, paymentMethod: cashMovementMethod, note: cashMovementNote.trim(), createdAt: new Date().toISOString(), synced: false };
    await db.cashMovements.add(movement);
    setCashMovementAmount(""); setCashMovementNote("");
    await refreshLocal(); notify("success", cashMovementKind === "withdrawal" ? "Retrait enregistré dans la caisse." : "Apport enregistré dans la caisse."); void synchronize();
  }

  async function saveCashClosing(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const openingCash = Number(cashOpening);
    const countedCash = Number(cashCounted);
    if (!Number.isInteger(openingCash) || openingCash < 0 || !Number.isInteger(countedCash) || countedCash < 0) return notify("error", "Saisissez des montants de caisse valides.");
    const closing: CashClosing = { id: `${ownerUid.replaceAll(":", "_")}_${cashDate}`, ownerUid, date: cashDate, openingCash, countedCash, expectedCash, note: cashCloseNote.trim(), closedAt: new Date().toISOString(), synced: false };
    await db.cashClosings.put(closing);
    await refreshLocal(); notify("success", "Clôture de caisse enregistrée."); void synchronize();
  }

  async function exportBackup() {
    const data = {
      format: "zambo-backup-v4",
      exportedAt: new Date().toISOString(),
      shop: { name: shopName, currency },
      products,
      sales,
      expenses,
      debts,
      debtPayments,
      suppliers,
      stockLosses,
      purchases,
      supplierPayments,
      cashMovements,
      cashClosings,
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

  function exportReportExcel() {
    const rows = [
      ["Type", "Date", "Libellé", "Mode", "Quantité", "Montant FCFA"],
      ...reportSales.map((sale) => ["Vente", dayLabel(sale.createdAt), sale.items.map((item) => `${item.quantity}x ${item.productName}`).join(" / "), paymentLabel(sale.paymentMethod), String(sale.items.reduce((sum, item) => sum + item.quantity, 0)), String(sale.total)]),
      ...reportPayments.map((payment) => ["Remboursement client", dayLabel(payment.createdAt), debts.find((debt) => debt.id === payment.debtId)?.customerName ?? "Client", paymentLabel(payment.paymentMethod), "", String(payment.amount)]),
      ...reportExpenses.map((expense) => ["Dépense", dayLabel(expense.createdAt), expense.label, paymentLabel(expense.paymentMethod), "", String(expense.amount)]),
      ...reportPurchases.map((purchase) => ["Achat fournisseur", dayLabel(purchase.createdAt), `${purchase.productName} · ${purchase.supplierName}`, paymentLabel(purchase.paymentMethod), String(purchase.quantity), String(purchase.total)]),
      ...reportLosses.map((loss) => ["Perte de stock", dayLabel(loss.createdAt), `${loss.productName} (${loss.quantity}) · ${loss.reason}`, "", String(loss.quantity), String(loss.unitCost * loss.quantity)]),
      ["Pertes de stock", "", "Valeur au prix d’achat", String(reportStockLossValue)],
      ["Bénéfice brut", "", "Ventes moins coût d’achat", String(reportGrossProfit)],
      ["Marge brute %", "", "Bénéfice brut ÷ ventes", `${reportGrossMarginRate.toFixed(1)} %`],
      ["Seuil de rentabilité estimé", "", "Ventes nécessaires pour couvrir dépenses et pertes", reportGrossMarginRate > 0 ? String(breakEvenSalesTarget) : "Non calculable"],
      ["Argent encaissé", "", "Paiements de vente + remboursements clients", String(reportCashCollected)],
      ["Résultat net estimé", "", "Après dépenses et pertes de stock", String(reportNetResult)],
    ];
    const csv = `\uFEFF${rows.map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(";")).join("\r\n")}`;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `bingi-bilan-${reportPeriod === "day" ? reportDate : reportPeriod === "month" ? reportMonth : "general"}.csv`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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
        (backup.format !== "zambo-backup-v1" && backup.format !== "zambo-backup-v2" && backup.format !== "zambo-backup-v3" && backup.format !== "zambo-backup-v4")
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
        suppliers?: Supplier[];
        stockLosses?: StockLoss[];
        purchases?: Purchase[];
        supplierPayments?: SupplierPayment[];
        cashMovements?: CashMovement[];
        cashClosings?: CashClosing[];
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
      await db.transaction("rw", [db.products, db.sales, db.expenses, db.debts, db.debtPayments, db.suppliers, db.stockLosses, db.purchases, db.supplierPayments, db.cashMovements, db.cashClosings], async () => {
        for (const item of content.products ?? []) await db.products.put({ ...item, ownerUid, synced: false });
        for (const item of content.sales ?? []) await db.sales.put({ ...item, ownerUid, synced: false });
        for (const item of content.expenses ?? []) await db.expenses.put({ ...item, ownerUid, synced: false });
        for (const item of content.debts ?? []) await db.debts.put({ ...item, ownerUid, isPaid: item.isPaid ?? false, synced: false });
        for (const item of content.debtPayments ?? []) await db.debtPayments.put({ ...item, ownerUid, synced: false });
        for (const item of content.suppliers ?? []) await db.suppliers.put({ ...item, ownerUid, synced: false });
        for (const item of content.stockLosses ?? []) await db.stockLosses.put({ ...item, ownerUid, synced: false });
        for (const item of content.purchases ?? []) await db.purchases.put({ ...item, ownerUid, synced: false });
        for (const item of content.supplierPayments ?? []) await db.supplierPayments.put({ ...item, ownerUid, synced: false });
        for (const item of content.cashMovements ?? []) await db.cashMovements.put({ ...item, ownerUid, synced: false });
        for (const item of content.cashClosings ?? []) await db.cashClosings.put({ ...item, ownerUid, synced: false });
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

  const pageTitle = {
    dashboard: "Accueil",
    products: "Produits & stock",
    sales: "Ventes",
    expenses: "Dépenses",
    debts: "Crédits clients",
    purchases: "Achats fournisseurs",
    cash: "Caisse journalière",
    reports: "Bilans détaillés",
    suppliers: "Fournisseurs & réapprovisionnement",
    losses: "Pertes de stock",
    settings: "Paramètres",
  }[section];

  const visibleSales = sales;
  const totalExpenses = expenses.reduce((sum, expense) => sum + expense.amount, 0);
  const outstandingDebts = debts.reduce((sum, debt) => sum + remainingForDebt(debt), 0);
  const totalProfit = sales.reduce((sum, sale) => sum + sale.items.reduce((subtotal, item) => subtotal + (item.unitPrice - item.costPrice) * item.quantity, 0), 0);
  const stockValue = products.reduce((sum, product) => sum + product.costPrice * product.stock, 0);
  const inReportPeriod = (value: string) => reportPeriod === "all" || (reportPeriod === "day" ? isOnDay(value, reportDate) : value.slice(0, 7) === reportMonth);
  const reportSales = sales.filter((sale) => inReportPeriod(sale.createdAt));
  const reportExpenses = expenses.filter((expense) => inReportPeriod(expense.createdAt));
  const reportDebts = debts.filter((debt) => inReportPeriod(debt.createdAt));
  const reportPayments = debtPayments.filter((payment) => inReportPeriod(payment.createdAt));
  const reportLosses = stockLosses.filter((loss) => inReportPeriod(loss.createdAt));
  const reportSalesTotal = reportSales.reduce((sum, sale) => sum + sale.total, 0);
  const reportExpenseTotal = reportExpenses.reduce((sum, expense) => sum + expense.amount, 0);
  const reportDebtTotal = reportDebts.reduce((sum, debt) => sum + debt.amount, 0);
  const reportPaymentTotal = reportPayments.reduce((sum, payment) => sum + payment.amount, 0);
  const reportCashCollected = reportSales.reduce((sum, sale) => sum + ((sale.paymentMethod ?? "cash") === "credit" ? sale.amountPaid ?? 0 : sale.amountPaid ?? sale.total), 0) + reportPayments.reduce((sum, payment) => sum + payment.amount, 0);
  const reportGrossProfit = reportSales.reduce((sum, sale) => sum + sale.items.reduce((partial, item) => partial + (item.unitPrice - item.costPrice) * item.quantity, 0), 0);
  const reportStockLossValue = reportLosses.reduce((sum, loss) => sum + loss.unitCost * loss.quantity, 0);
  const reportPurchases = purchases.filter((purchase) => inReportPeriod(purchase.createdAt) && !purchase.isDeleted);
  const reportNetResult = reportGrossProfit - reportExpenseTotal - reportStockLossValue;
  const totalStockLossValue = stockLosses.reduce((sum, loss) => sum + loss.unitCost * loss.quantity, 0);
  const overdueDebts = debts.filter((debt) => isDebtOverdue(debt, remainingForDebt(debt)));
  const reportGrossMarginRate = reportSalesTotal > 0 ? reportGrossProfit / reportSalesTotal : 0;
  const breakEvenSalesTarget = reportGrossMarginRate > 0 ? Math.ceil((reportExpenseTotal + reportStockLossValue) / reportGrossMarginRate) : 0;
  const productSales = useMemo(() => {
    const totals = new Map<string, { productId: string; productName: string; quantity: number; revenue: number; cost: number; lastSoldAt: string }>();
    for (const sale of reportSales) for (const item of sale.items) {
      const entry = totals.get(item.productId) ?? { productId: item.productId, productName: item.productName, quantity: 0, revenue: 0, cost: 0, lastSoldAt: sale.createdAt };
      entry.quantity += item.quantity; entry.revenue += item.unitPrice * item.quantity; entry.cost += item.costPrice * item.quantity;
      if (sale.createdAt > entry.lastSoldAt) entry.lastSoldAt = sale.createdAt;
      totals.set(item.productId, entry);
    }
    return [...totals.values()].map((entry) => {
      const product = products.find((item) => item.id === entry.productId);
      const purchased = reportPurchases.filter((purchase) => purchase.productId === entry.productId).reduce((sum, purchase) => sum + purchase.quantity, 0);
      const lost = reportLosses.filter((loss) => loss.productId === entry.productId).reduce((sum, loss) => sum + loss.quantity, 0);
      const currentStock = product?.stock ?? 0;
      const estimatedOpening = Math.max(0, currentStock + entry.quantity + lost - purchased);
      const averageStock = (estimatedOpening + currentStock) / 2;
      return { ...entry, margin: entry.revenue ? (entry.revenue - entry.cost) / entry.revenue * 100 : 0, turnover: averageStock > 0 ? entry.quantity / averageStock : 0 };
    }).sort((a, b) => b.quantity - a.quantity);
  }, [reportSales, products, reportPurchases, reportLosses]);
  const agingToday = dateInputValue(new Date());
  const creditAging = useMemo(() => debts.reduce((buckets, debt) => {
    const remaining = remainingForDebt(debt);
    if (remaining <= 0 || !debt.dueDate || debt.dueDate >= agingToday) return buckets;
    const daysLate = Math.floor((new Date(`${agingToday}T12:00:00`).getTime() - new Date(`${debt.dueDate}T12:00:00`).getTime()) / 86400000);
    const bucket = daysLate <= 30 ? "1–30 j" : daysLate <= 60 ? "31–60 j" : "Plus de 60 j";
    buckets[bucket] += remaining;
    return buckets;
  }, { "1–30 j": 0, "31–60 j": 0, "Plus de 60 j": 0 }), [debts, remainingForDebt, agingToday]);
  const cashSales = sales.filter((sale) => isOnDay(sale.createdAt, cashDate) && (sale.paymentMethod ?? "cash") !== "credit");
  const cashSaleByMethod = (method: Exclude<PaymentMethod, "credit">) => cashSales.filter((sale) => (sale.paymentMethod ?? "cash") === method).reduce((sum, sale) => sum + (sale.amountPaid ?? sale.total), 0);
  const cashDebtPayments = debtPayments.filter((payment) => isOnDay(payment.createdAt, cashDate) && !payment.isDeleted);
  const cashExpenses = expenses.filter((expense) => isOnDay(expense.createdAt, cashDate) && !expense.isDeleted);
  const cashPurchases = purchases.filter((purchase) => isOnDay(purchase.createdAt, cashDate) && !purchase.isDeleted);
  const cashSupplierPayments = supplierPayments.filter((payment) => isOnDay(payment.createdAt, cashDate) && !payment.isDeleted);
  const todayMovements = cashMovements.filter((movement) => isOnDay(movement.createdAt, cashDate) && !movement.isDeleted);
  const sumMethod = <T extends { paymentMethod?: PaymentMethod; amount?: number; amountPaid?: number }>(items: T[], method: PaymentMethod) => items.filter((item) => (item.paymentMethod ?? "cash") === method).reduce((sum, item) => sum + (item.amount ?? item.amountPaid ?? 0), 0);
  const cashReceipts = cashSaleByMethod("cash") + sumMethod(cashDebtPayments, "cash");
  const cashPaidOut = sumMethod(cashExpenses, "cash") + cashPurchases.filter((purchase) => purchase.paymentMethod === "cash").reduce((sum, purchase) => sum + purchase.amountPaid, 0) + sumMethod(cashSupplierPayments, "cash");
  const cashMovementNet = todayMovements.filter((movement) => movement.paymentMethod === "cash").reduce((sum, movement) => sum + (movement.kind === "deposit" ? movement.amount : -movement.amount), 0);
  const expectedCash = Number(cashOpening || 0) + cashReceipts - cashPaidOut + cashMovementNet;
  const closedCashToday = cashClosings.find((closing) => closing.date === cashDate);
  const previousCashClosing = cashClosings.filter((closing) => closing.date < cashDate).sort((a, b) => b.date.localeCompare(a.date))[0];
  const channelNet = (method: Exclude<PaymentMethod, "credit">) => cashSaleByMethod(method) + sumMethod(cashDebtPayments, method) - sumMethod(cashExpenses, method) - cashPurchases.filter((purchase) => purchase.paymentMethod === method).reduce((sum, purchase) => sum + purchase.amountPaid, 0) - sumMethod(cashSupplierPayments, method) + todayMovements.filter((movement) => movement.paymentMethod === method).reduce((sum, movement) => sum + (movement.kind === "deposit" ? movement.amount : -movement.amount), 0);
  const outstandingSupplierByPurchase = (purchase: Purchase) => Math.max(0, purchase.total - purchase.amountPaid - (paidBySupplierPurchase.get(purchase.id) ?? 0));
  const totalSupplierDebt = purchases.reduce((sum, purchase) => sum + outstandingSupplierByPurchase(purchase), 0);

  useEffect(() => {
    setCashOpening(String(closedCashToday?.openingCash ?? previousCashClosing?.countedCash ?? 0));
    setCashCounted(closedCashToday ? String(closedCashToday.countedCash) : "");
    setCashCloseNote(closedCashToday?.note ?? "");
  }, [cashDate, closedCashToday, previousCashClosing]);

  useEffect(() => {
    if (modal === "sale" && !editingSale) {
      setSalePaymentMethod("cash");
      setSaleCustomerName("");
      setSaleCustomerPhone("");
    }
  }, [modal, editingSale]);

  if (!authReady) {
    return <div className="startup-screen"><span className="brand-logo brand-logo-startup" role="img" aria-label="Logo Bĩngi" /><p>Vérification du compte…</p></div>;
  }

  if (!ownerUid) {
    return <main className="startup-screen"><span className="brand-logo brand-logo-startup" role="img" aria-label="Logo Bĩngi" /><p>Ouverture de votre boutique…</p></main>;
  }

  if (!authGatePassed) {
    return (
      <div className="auth-page">
        <section className="auth-card">
          <span className="brand-logo brand-logo-auth" role="img" aria-label="Logo Bĩngi" />
          <span className="eyebrow">BĨNGI · GESTION DE BOUTIQUE</span>
          <h1>{authMode === "register" ? "Créer votre compte" : "Retrouver votre compte"}</h1>
          <p className="auth-description">{authMode === "register" ? "Inscrivez-vous avec votre numéro et un code secret. Aucun SMS n’est envoyé. Votre compte pourra être retrouvé sur un autre téléphone." : "Connectez-vous avec le même numéro et le code secret choisis à l’inscription."}</p>
          <section className="auth-premium-card">
            <div><span className="eyebrow">OPTION PREMIUM</span><strong>1 000 FCFA / mois</strong><p>Bilans détaillés, gestion des fournisseurs et jusqu’à 3 boutiques. Demande d’activation par WhatsApp après inscription.</p></div>
            <button className="button button-whatsapp" type="button" onClick={() => { setAuthMode("register"); setModal("premium"); setAuthMessage(""); }}>Créer un compte et demander Premium ↗</button>
          </section>
          <label>Numéro de téléphone
            <input autoFocus value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+226 70 00 00 00" inputMode="tel" autoComplete="tel" />
          </label>
          <label>Code secret (6 à 12 chiffres)
            <input type="password" value={accountPassword} onChange={(event) => setAccountPassword(event.target.value.replace(/\D/g, "").slice(0, 12))} placeholder="••••••" inputMode="numeric" autoComplete={authMode === "login" ? "current-password" : "new-password"} />
          </label>
          <p className="auth-note">Sans SMS, le numéro n’est pas vérifié. Mémorisez votre code : aucune récupération automatique n’est disponible.</p>
          {authMessage && <p className="auth-message" role="alert">{authMessage}</p>}
          {firebaseConfigured
            ? <button className="button button-primary local-button" disabled={authBusy || !phone || !accountPassword} onClick={() => void createAccountWithoutSms()}>{authBusy ? "Connexion…" : authMode === "register" ? "Créer mon compte" : "Me connecter"}</button>
            : <div className="setup-notice"><strong>La création de compte est indisponible.</strong><span>Réessayez plus tard ou continuez sans compte sur cet appareil.</span></div>}
          <button className="text-button local-button" onClick={() => { setAuthMode(authMode === "register" ? "login" : "register"); setAuthMessage(""); }}>{authMode === "register" ? "J’ai déjà un compte — me connecter" : "Créer un compte"}</button>
        </section>
        <aside className="auth-aside"><div className="aside-copy"><span>VOS VENTES ET VOTRE STOCK</span><h2>Votre boutique vous suit, même sans connexion.</h2></div></aside>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand brand-logo-button" onClick={() => setSection("dashboard")} aria-label="Bĩngi, accueil"><span className="brand-logo brand-logo-sidebar" role="img" aria-label="Bĩngi — Gestion de Boutique" /></button>
        <div className="shop-switcher"><div className="shop-avatar">{(shopName || "M").slice(0, 1).toUpperCase()}</div><div className="shop-switcher-info">{user && shops.length > 1 ? <select aria-label="Choisir une boutique" value={ownerUid} onChange={(event) => void switchBoutique(event.target.value)}>{shops.map((item) => <option key={item.ownerUid} value={item.ownerUid}>{item.name}</option>)}</select> : <strong>{shopName || "Ma boutique"}</strong>}<small>{user ? `${shops.length} / 3 boutiques · sauvegardées` : "Mode gratuit · sans compte"}</small></div><span className="chevron">⌄</span></div>
        <span className="nav-caption">MENU PRINCIPAL</span>
        <nav className="main-nav">
          {navItems.map((item) => (
            <button key={item.id} className={`nav-link ${section === item.id ? "active" : ""}`} onClick={() => setSection(item.id)}>
              <span className="nav-icon">{item.icon}</span><span>{item.label}</span>{item.id === "debts" && overdueDebts.length > 0 && <span className="overdue-count">{overdueDebts.length}</span>}{item.premium && !premium && <span className="pro-tag">PRO</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className={`plan-card ${premium ? "plan-active" : ""}`}><div className="plan-card-top"><span>{premium ? "✦ PREMIUM" : "OFFRE GRATUITE"}</span><span>{premium ? "●" : "↗"}</span></div><strong>{premium ? "Votre boutique est Premium" : "Les outils essentiels sont gratuits"}</strong><p>{premium ? "Merci de soutenir Bĩngi." : "Stock, ventes et sauvegarde en ligne gratuite."}</p>{!premium && <button onClick={() => setSection("settings")}>Voir Premium <span>→</span></button>}</div>
          <div className="profile-row"><div className="profile-avatar">{(shop?.phone ?? user?.phoneNumber)?.slice(-2) ?? "Z"}</div><div className="profile-info"><strong>{user ? shop?.phone ?? user.phoneNumber ?? "Compte connecté" : "Sans compte"}</strong><small>{user ? (premium ? "Compte Premium" : "Compte en ligne gratuit") : "Données sur cet appareil"}</small></div>{user && !user.isAnonymous && <button className="more-button" aria-label="Déconnexion" title="Déconnecter le compte en ligne" onClick={async () => { if (auth) await signOut(auth); }}>⋯</button>}</div>
        </div>
      </aside>

      {mobileMenuOpen && <div className="mobile-drawer-backdrop" onClick={() => setMobileMenuOpen(false)}>
        <aside className="mobile-drawer" role="dialog" aria-modal="true" aria-label="Menu principal" onClick={(event) => event.stopPropagation()}>
          <div className="mobile-drawer-heading"><div><strong>Menu principal</strong><span>{shopName || "Ma boutique"}</span></div><button className="mobile-drawer-close" onClick={() => setMobileMenuOpen(false)} aria-label="Fermer le menu">×</button></div>
          <nav aria-label="Rubriques de l’application">{navItems.map((item) => <button key={item.id} className={`mobile-drawer-link ${section === item.id ? "active" : ""}`} onClick={() => { setSection(item.id); setMobileMenuOpen(false); }}><span className="nav-icon">{item.icon}</span><span>{item.label}</span>{item.id === "debts" && overdueDebts.length > 0 && <span className="overdue-count">{overdueDebts.length}</span>}{item.premium && !premium && <span className="pro-tag">PRO</span>}</button>)}</nav>
          <section className="mobile-premium-card"><strong>{premium ? "Premium est activé" : "Découvrez Premium"}</strong><span>{premium ? "Profitez de vos outils avancés." : "1 000 FCFA par mois · Activation via WhatsApp"}</span>{!premium && <button onClick={() => { setMobileMenuOpen(false); openPremiumRequest(); }}>Voir l’offre Premium ↗</button>}</section>
        </aside>
      </div>}

      <main className="main-area">
        <header className="topbar"><button className="mobile-menu-trigger" aria-expanded={mobileMenuOpen} onClick={() => setMobileMenuOpen(true)}><span aria-hidden="true">☰</span><span>Menu</span></button><div className="breadcrumbs"><span>{shopName || "Ma boutique"}</span><b>/</b><strong>{pageTitle}</strong></div><div className="top-actions">{user && shops.length > 1 && <label className="top-shop-picker"><span>🏪 Boutique</span><select className="top-shop-select" aria-label="Changer de boutique" value={ownerUid} onChange={(event) => void switchBoutique(event.target.value)}>{shops.map((item) => <option key={item.ownerUid} value={item.ownerUid}>{item.name}</option>)}</select></label>}<button className="button button-outline install-button" onClick={() => void installApp()}>Installer</button><div className={`connection-pill ${syncing ? "busy" : ""}`}><span />{user ? (syncing ? "Sauvegarde…" : "Données sauvegardées") : "Enregistré sur cet appareil"}</div><button className="icon-button" title="Alertes de stock" onClick={() => setSection("products")}>♧{lowStock.length > 0 && <i />}</button><div className="top-avatar">{shopName.slice(0, 1).toUpperCase() || "M"}</div></div></header>
        <div className="page-content">
          <div className="page-heading"><div><span className="eyebrow">{new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" }).toUpperCase()}</span><h1>{section === "dashboard" ? `Bonjour${shopName ? `, ${shopName}` : ""} 👋` : pageTitle}</h1><p>{section === "dashboard" ? "Votre activité, simplement. Vous pouvez utiliser l’application sans créer de compte." : "Les informations sont enregistrées automatiquement."}</p></div><div className="heading-actions">{section === "dashboard" && products.length > 0 && <button className="button button-outline" onClick={() => setSection("sales")}>＋ Nouvelle vente</button>}{section === "dashboard" && products.length === 0 && <button className="button button-primary" onClick={() => setModal("product")}>＋ Ajouter mon premier produit</button>}{section === "products" && <button className="button button-primary" onClick={() => setModal("product")}>＋ Ajouter un produit</button>}{section === "sales" && <button className="button button-primary" onClick={() => setModal("sale")}>＋ Nouvelle vente</button>}</div></div>

          {loading && <div className="loading-banner">Chargement de vos données…</div>}

          {section === "dashboard" && products.length === 0 && <section className="starter-card">
            <div className="starter-number">1</div>
            <div className="starter-copy"><strong>Commençons simplement</strong><span>Ajoutez vos articles. Ensuite, touchez « Vendre » à chaque vente : le stock se mettra à jour tout seul.</span></div>
            <button className="button button-primary" onClick={() => { setEditingProduct(null); setModal("product"); }}>Ajouter mon premier article</button>
          </section>}
          {section === "dashboard" && !premium && <section className="backup-reminder premium-dashboard-offer">
            <div><strong>Accéder à Premium · 1 000 FCFA / mois</strong><span>Débloquez les bilans détaillés, la gestion avancée et jusqu’à 3 boutiques. Après paiement, l’activation se fait manuellement par WhatsApp.</span></div>
            {accountActivationUrl
              ? <a className="button button-whatsapp" href={accountActivationUrl} target="_blank" rel="noreferrer">Demander sur WhatsApp ↗</a>
              : <button className="button button-whatsapp" onClick={openPremiumRequest}>Accéder à Premium ↗</button>}
          </section>}
          {section === "dashboard" && <Dashboard
            revenue={todayRevenue} saleCount={todaySales.length} profit={todayProfit} stockCount={products.length}
            lowStock={lowStock} sales={visibleSales.slice(0, 5)} currency={currency} premium={premium}
            onNewSale={() => { setEditingSale(null); setModal("sale"); }} onNewProduct={() => { setEditingProduct(null); setModal("product"); }} onProducts={() => setSection("products")} onAllSales={() => setSection("sales")}
            onReceipt={openReceipt}
          />}
          {section === "products" && <section className="panel"><div className="panel-toolbar"><div><h2>Mes articles</h2><p>{products.length} article{products.length === 1 ? "" : "s"} · {premium ? "Autant que vous voulez" : `${Math.max(0, 30 - products.length)} places gratuites restantes`}</p></div><div className="search-field"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Chercher un article…" /></div></div><ProductsTable products={filteredProducts} currency={currency} premium={premium} onRestock={(product) => { if (!premium) return openPremiumRequest(); openRestock(product); }} onLoss={(product) => { if (!premium) return openPremiumRequest(); openLoss(product); }} onEdit={openProductEditor} onDelete={(product) => void deleteProduct(product)} /></section>}
          {section === "sales" && <section className="panel"><div className="panel-toolbar"><div><h2>Mes ventes</h2><p>{sales.length} vente(s) gardée(s) · historique complet gratuit</p></div><button className="button button-primary" onClick={() => { setEditingSale(null); setModal("sale"); }}>＋ Enregistrer une vente</button></div><SalesTable sales={visibleSales} currency={currency} onReceipt={openReceipt} premium={premium} onEdit={openSaleEditor} onDelete={(sale) => void deleteSale(sale)} /></section>}
          {section === "expenses" && <section className="panel"><div className="panel-toolbar"><div><h2>Suivi des dépenses</h2><p>Total enregistré : <b>{money(totalExpenses, currency)}</b></p></div><button className="button button-primary" onClick={() => setModal("expense")}>＋ Ajouter une dépense</button></div><ExpenseTable expenses={expenses} currency={currency} onEdit={openExpenseEditor} onDelete={(expense) => void deleteExpense(expense)} /></section>}
          {section === "suppliers" && premium && <section className="panel"><div className="panel-toolbar"><div><h2>Mes fournisseurs</h2><p>{suppliers.length} fournisseur(s) · {products.filter((item) => item.stock <= item.lowStockThreshold).length} article(s) à réapprovisionner</p></div><button className="button button-primary" onClick={() => { setEditingSupplier(null); setSupplierName(""); setSupplierPhone(""); setSupplierNote(""); setModal("supplier"); }}>＋ Ajouter un fournisseur</button></div>{suppliers.length ? <div className="table-wrap"><table><thead><tr><th>FOURNISSEUR</th><th>TÉLÉPHONE</th><th>NOTE</th><th>ACTIONS</th></tr></thead><tbody>{suppliers.map((supplier) => <tr key={supplier.id}><td className="strong-cell">{supplier.name}</td><td>{supplier.phone || "—"}</td><td>{supplier.note || "—"}</td><td><button className="small-action" onClick={() => openSupplierEditor(supplier)}>Modifier</button>{" "}<button className="small-action" onClick={() => void deleteSupplier(supplier)}>Supprimer</button></td></tr>)}</tbody></table></div> : <Empty message="Aucun fournisseur enregistré" detail="Ajoutez vos fournisseurs, puis associez-les à vos réapprovisionnements." />}<p className="report-explainer">Pour recevoir des articles, ouvrez Produits & stock et choisissez « Réapprovisionner » sur l’article concerné.</p></section>}
          {section === "suppliers" && !premium && <PremiumGate feature="La gestion des fournisseurs et les réapprovisionnements associés sont réservés à Premium." onUpgrade={openPremiumRequest} accountInactive={Boolean(user && shop?.estActif !== true)} userId={user?.uid} whatsappUrl={accountActivationUrl} onRefresh={() => void synchronize()} refreshing={syncing} />}
          {section === "losses" && premium && <section className="panel"><div className="panel-toolbar"><div><h2>Pertes de stock</h2><p>Valeur totale au prix d’achat : <b>{money(totalStockLossValue, currency)}</b></p></div></div>{stockLosses.length ? <div className="table-wrap"><table><thead><tr><th>ARTICLE</th><th>QUANTITÉ</th><th>MOTIF</th><th>DATE</th><th>VALEUR PERDUE</th></tr></thead><tbody>{stockLosses.map((loss) => <tr key={loss.id}><td className="strong-cell">{loss.productName}</td><td>{loss.quantity}</td><td>{loss.reason}</td><td>{dayLabel(loss.createdAt)}</td><td>{money(loss.quantity * loss.unitCost, currency)}</td></tr>)}</tbody></table></div> : <Empty message="Aucune perte enregistrée" detail="Depuis Produits & stock, choisissez « Déclarer une perte » pour ajuster la quantité." />}</section>}
          {section === "losses" && !premium && <PremiumGate feature="La déclaration et le suivi des pertes de stock sont réservés à Premium." onUpgrade={openPremiumRequest} accountInactive={Boolean(user && shop?.estActif !== true)} userId={user?.uid} whatsappUrl={accountActivationUrl} onRefresh={() => void synchronize()} refreshing={syncing} />}
          {section === "debts" && <section className="panel"><div className="panel-toolbar"><div><h2>Crédits clients</h2><p>Montant restant à récupérer : <b>{money(outstandingDebts, currency)}</b>{overdueDebts.length > 0 && <span className="overdue-banner"> · ⚠ {overdueDebts.length} crédit(s) en retard</span>}</p></div><button className="button button-primary" onClick={() => { setEditingDebt(null); setDebtDueDate(() => { const date = new Date(); date.setDate(date.getDate() + 30); return dateInputValue(date); }); setModal("debt"); }}>＋ Ajouter un crédit</button></div><DebtTable debts={debts} currency={currency} remainingForDebt={remainingForDebt} onPayment={(debt) => { setSelectedDebt(debt); setDebtPaymentAmount(""); setModal("debt-payment"); }} onEdit={openDebtEditor} onDelete={(debt) => void deleteDebt(debt)} /></section>}
          {section === "purchases" && premium && <section className="panel"><div className="panel-toolbar"><div><h2>Achats et paiements fournisseurs</h2><p>Montant restant à régler : <b>{money(totalSupplierDebt, currency)}</b></p></div></div><p className="report-explainer">Pour créer un achat, ouvrez Produits & stock puis « Réapprovisionner » : l’achat, le coût moyen du stock et le montant payé seront enregistrés ensemble.</p>{purchases.length ? <div className="table-wrap"><table><thead><tr><th>DATE</th><th>ARTICLE</th><th>FOURNISSEUR</th><th>QUANTITÉ</th><th>TOTAL</th><th>RESTE À PAYER</th><th>MODE</th><th>ACTION</th></tr></thead><tbody>{purchases.map((purchase) => { const due = outstandingSupplierByPurchase(purchase); return <tr key={purchase.id}><td>{dayLabel(purchase.createdAt)}</td><td className="strong-cell">{purchase.productName}</td><td>{purchase.supplierName}</td><td>{purchase.quantity}</td><td>{money(purchase.total, currency)}</td><td>{money(due, currency)}</td><td>{paymentLabel(purchase.paymentMethod)}</td><td>{due > 0 && <button className="small-action" onClick={() => { setSelectedPurchase(purchase); setSupplierPaymentAmount(""); setModal("supplier-payment"); }}>Régler</button>}</td></tr>; })}</tbody></table></div> : <Empty message="Aucun achat enregistré" detail="Chaque réapprovisionnement enregistré dans Produits & stock apparaîtra ici." />}</section>}
          {section === "purchases" && !premium && <PremiumGate feature="Le journal des achats, les dettes fournisseurs et leurs règlements sont réservés à Premium." onUpgrade={openPremiumRequest} accountInactive={Boolean(user && shop?.estActif !== true)} userId={user?.uid} whatsappUrl={accountActivationUrl} onRefresh={() => void synchronize()} refreshing={syncing} />}
          {section === "cash" && <div className="report-page"><section className="panel"><div className="panel-toolbar"><div><h2>Caisse du jour</h2><p>Comparez le solde calculé avec l’argent réellement compté.</p></div><label className="report-date">Journée<input type="date" value={cashDate} onChange={(event) => setCashDate(event.target.value)} /></label></div><div className="metrics-grid"><MetricCard label="Espèces reçues" value={money(cashReceipts, currency)} icon="＋" tone="green" hint={`${money(cashSaleByMethod("cash"), currency)} ventes · ${money(sumMethod(cashDebtPayments, "cash"), currency)} crédits`} /><MetricCard label="Solde Orange Money" value={money(channelNet("orange_money"), currency)} icon="↗" tone="gold" hint="Solde net estimé après sorties" /><MetricCard label="Solde Moov Money" value={money(channelNet("moov_money"), currency)} icon="↗" tone="blue" hint="Solde net estimé après sorties" /><MetricCard label="Solde espèces attendu" value={money(expectedCash, currency)} icon="▣" tone="blue" hint="Après dépenses, achats, apports et retraits en espèces" /></div><div className="report-summary"><SummaryLine label="Dépenses payées en espèces" value={`− ${money(sumMethod(cashExpenses, "cash"), currency)}`} /><SummaryLine label="Achats fournisseurs payés en espèces" value={`− ${money(cashPurchases.filter((purchase) => purchase.paymentMethod === "cash").reduce((sum, purchase) => sum + purchase.amountPaid, 0) + sumMethod(cashSupplierPayments, "cash"), currency)}`} /><SummaryLine label="Mouvements espèces (apports − retraits)" value={money(cashMovementNet, currency)} bold /></div></section><div className="report-grid"><section className="panel"><h2>Clôture de caisse</h2><form className="modal-form" onSubmit={(event) => void saveCashClosing(event)}><label>Fond de caisse au début ({currency})<input required type="number" min="0" step="1" value={cashOpening} onChange={(event) => setCashOpening(event.target.value)} /></label><label>Espèces comptées en fin de journée ({currency})<input required type="number" min="0" step="1" value={cashCounted} onChange={(event) => setCashCounted(event.target.value)} /></label><label>Note sur l’écart (facultatif)<textarea rows={2} value={cashCloseNote} onChange={(event) => setCashCloseNote(event.target.value)} /></label><div className="sale-total">Écart caisse réelle − attendue <strong>{cashCounted === "" ? "À compter" : money(Number(cashCounted) - expectedCash, currency)}</strong></div><ModalActions onCancel={() => setCashCounted("")} submit={closedCashToday ? "Mettre à jour la clôture" : "Enregistrer la clôture"} /></form>{closedCashToday && <p className="report-explainer">Clôture enregistrée le {dayLabel(closedCashToday.closedAt)}.</p>}</section><section className="panel"><h2>Apport ou retrait</h2><form className="modal-form" onSubmit={(event) => void addCashMovement(event)}><label>Type<select value={cashMovementKind} onChange={(event) => setCashMovementKind(event.target.value as "deposit" | "withdrawal")}><option value="withdrawal">Retrait / sortie de caisse</option><option value="deposit">Apport / entrée de caisse</option></select></label><label>Montant ({currency})<input required type="number" min="1" step="1" value={cashMovementAmount} onChange={(event) => setCashMovementAmount(event.target.value)} /></label><label>Canal<select value={cashMovementMethod} onChange={(event) => setCashMovementMethod(event.target.value as Exclude<PaymentMethod, "credit">)}><option value="cash">Espèces</option><option value="orange_money">Orange Money</option><option value="moov_money">Moov Money</option></select></label><label>Motif<input required value={cashMovementNote} onChange={(event) => setCashMovementNote(event.target.value)} placeholder="Ex. Dépôt au coffre, retrait personnel…" /></label><ModalActions onCancel={() => { setCashMovementAmount(""); setCashMovementNote(""); }} submit="Enregistrer le mouvement" /></form></section></div></div>}
          {section === "reports" && premium && <div className="report-page">
            <nav className="report-mobile-nav" aria-label="Sections du bilan"><a href="#report-totals">Chiffres clés</a><a href="#report-sales">Ventes et résumé</a><a href="#report-products">Produits</a><a href="#report-credit-aging">Crédits en retard</a><a href="#report-slow-stock">Stock sans vente</a></nav>
            <section className="panel" id="report-totals">
              <div className="panel-toolbar report-toolbar"><div><h2>Bilan {reportPeriod === "day" ? "journalier" : reportPeriod === "month" ? "mensuel" : "général"}</h2><p>Rentabilité, bénéfice brut, dépenses et pertes sur la période choisie.</p></div><div className="report-controls"><label className="report-date">Période<select value={reportPeriod} onChange={(event) => setReportPeriod(event.target.value as "day" | "month" | "all")}><option value="day">Journée</option><option value="month">Mois</option><option value="all">Général</option></select></label>{reportPeriod === "day" ? <label className="report-date">Date<input type="date" value={reportDate} onChange={(event) => setReportDate(event.target.value)} /></label> : reportPeriod === "month" ? <label className="report-date">Mois<input type="month" value={reportMonth} onChange={(event) => setReportMonth(event.target.value)} /></label> : null}<button className="button button-outline no-print" onClick={exportReportExcel}>↓ Excel / CSV</button><button className="button button-outline no-print" onClick={() => window.print()}>PDF / Imprimer</button></div></div>
              <div className="metrics-grid">
                <MetricCard label="Ventes" value={money(reportSalesTotal, currency)} icon="↗" tone="green" hint={`${reportSales.length} vente(s)`} />
                <MetricCard label="Dépenses" value={money(reportExpenseTotal, currency)} icon="↘" tone="gold" hint={`${reportExpenses.length} dépense(s)`} />
                <MetricCard label="Pertes de stock" value={money(reportStockLossValue, currency)} icon="⚠" tone="rose" hint={`${reportLosses.length} perte(s) enregistrée(s)`} />
                <MetricCard label="Bénéfice brut" value={money(reportGrossProfit, currency)} icon="✧" tone="blue" hint="Ventes moins coût des articles" />
                <MetricCard label={reportNetResult < 0 ? "Pertes" : "Bénéfice net estimé"} value={money(Math.abs(reportNetResult), currency)} icon={reportNetResult < 0 ? "!" : "✓"} tone={reportNetResult < 0 ? "rose" : "green"} hint="Après déduction des dépenses" />
                <MetricCard label="Argent encaissé" value={money(reportCashCollected, currency)} icon="✓" tone="blue" hint={`${money(reportPaymentTotal, currency)} de remboursements inclus`} />
                <MetricCard label="Marge brute" value={`${reportGrossMarginRate.toFixed(1)} %`} icon="%" tone="blue" hint="Bénéfice brut ÷ ventes" />
                <MetricCard label="Seuil de rentabilité estimé" value={money(breakEvenSalesTarget, currency)} icon="◎" tone="gold" hint="Ventes nécessaires pour couvrir dépenses et pertes" />
              </div>
              <p className="report-explainer">Le bénéfice brut déduit le coût moyen d’achat enregistré des articles vendus. La marge est une estimation; le seuil de rentabilité suppose que la marge observée reste identique. Les crédits ne sont pas des encaissements tant qu’ils ne sont pas payés.</p>
              <div className="report-summary"><SummaryLine label="Remboursements de crédits reçus" value={money(reportPaymentTotal, currency)} /><SummaryLine label="Crédits accordés" value={money(reportDebtTotal, currency)} /><SummaryLine label="Dépenses de la période" value={`− ${money(reportExpenseTotal, currency)}`} /><SummaryLine label="Pertes de stock" value={`− ${money(reportStockLossValue, currency)}`} /><SummaryLine label={reportNetResult < 0 ? "Perte nette estimée" : "Bénéfice net estimé"} value={money(Math.abs(reportNetResult), currency)} bold /></div>
            </section>
            <div className="metrics-grid">
              <MetricCard label="Bénéfice brut estimé" value={money(totalProfit, currency)} icon="↗" tone="green" hint="Ventes moins prix d’achat" />
              <MetricCard label="Dépenses enregistrées" value={money(totalExpenses, currency)} icon="↘" tone="gold" hint={`${expenses.length} dépense(s)`} />
              <MetricCard label="Pertes de stock" value={money(totalStockLossValue, currency)} icon="⚠" tone="rose" hint={`${stockLosses.length} perte(s)`} />
              <MetricCard label="Valeur du stock" value={money(stockValue, currency)} icon="▤" tone="blue" hint="Au prix d’achat" />
              <MetricCard label="Crédits à récupérer" value={money(outstandingDebts, currency)} icon="◷" tone="rose" hint={`${debts.filter((debt) => remainingForDebt(debt) > 0).length} crédit(s) en cours`} />
            </div>
            <div className="report-grid" id="report-sales"><section className="panel"><div className="panel-toolbar"><div><h2>Ventes de la période</h2><p>{reportSales.length} vente(s)</p></div></div><div className="report-sales-table"><SalesTable sales={reportSales} currency={currency} onReceipt={openReceipt} premium={premium} /></div></section><section className="panel report-summary"><h2>Résumé de la période</h2><SummaryLine label="Chiffre d’affaires" value={money(reportSalesTotal, currency)} /><SummaryLine label="Argent encaissé (ventes + remboursements)" value={money(reportCashCollected, currency)} /><SummaryLine label="Crédits accordés" value={money(reportDebtTotal, currency)} /><SummaryLine label="Bénéfice brut" value={money(reportGrossProfit, currency)} /><SummaryLine label="Dépenses" value={`− ${money(reportExpenseTotal, currency)}`} /><SummaryLine label="Pertes de stock" value={`− ${money(reportStockLossValue, currency)}`} /><SummaryLine label="Bénéfice après dépenses et pertes" value={money(reportNetResult, currency)} bold /></section></div>
            <div className="report-grid" id="report-products"><section className="panel"><div className="panel-toolbar"><div><h2>Produits les plus vendus</h2><p>Quantités, marges et rotation estimée sur la période.</p></div></div>{productSales.length ? <div className="table-wrap report-products-table"><table><thead><tr><th>ARTICLE</th><th>QUANTITÉ</th><th>CHIFFRE D’AFFAIRES</th><th>MARGE</th><th>MARGE %</th><th>ROTATION ESTIMÉE</th></tr></thead><tbody>{productSales.slice(0, 10).map((item) => <tr key={item.productId}><td className="strong-cell">{item.productName}</td><td>{item.quantity}</td><td>{money(item.revenue, currency)}</td><td>{money(item.revenue - item.cost, currency)}</td><td>{item.margin.toFixed(1)} %</td><td>{item.turnover.toFixed(2)}×</td></tr>)}</tbody></table></div> : <Empty message="Pas encore de ventes sur cette période" detail="Les produits vendus apparaîtront ici." />}<p className="report-explainer">La rotation est indicative : elle utilise le stock actuel et les achats/pertes enregistrés; un stock de départ ou un ajustement saisi hors historique peut modifier le résultat.</p></section><section className="panel" id="report-credit-aging"><h2>Crédits en retard</h2><p className="report-explainer">Reste à recevoir par ancienneté depuis l’échéance.</p><div className="report-summary"><SummaryLine label="1 à 30 jours" value={money(creditAging["1–30 j"], currency)} /><SummaryLine label="31 à 60 jours" value={money(creditAging["31–60 j"], currency)} /><SummaryLine label="Plus de 60 jours" value={money(creditAging["Plus de 60 j"], currency)} bold /></div></section></div>
            <section className="panel" id="report-slow-stock"><div className="panel-toolbar"><div><h2>Articles sans vente depuis 30 jours</h2><p>Basé sur l’historique disponible sur ce téléphone/compte.</p></div></div>{products.filter((product) => product.stock > 0 && (!sales.some((sale) => sale.items.some((item) => item.productId === product.id) && new Date(sale.createdAt).getTime() >= Date.now() - 30 * 86400000))).length ? <div className="alert-list">{products.filter((product) => product.stock > 0 && !sales.some((sale) => sale.items.some((item) => item.productId === product.id) && new Date(sale.createdAt).getTime() >= Date.now() - 30 * 86400000)).slice(0, 10).map((product) => <div className="alert-row" key={product.id}><div className="product-placeholder">{product.name.slice(0, 1).toUpperCase()}</div><div className="alert-info"><strong>{product.name}</strong><small>Stock disponible : {product.stock}</small></div><span className="stock-warning">{sales.some((sale) => sale.items.some((item) => item.productId === product.id)) ? "À surveiller" : "Jamais vendu"}</span></div>)}</div> : <Empty message="Aucun stock dormant détecté" detail="Tous les produits en stock ont été vendus récemment." />}</section>
          </div>}
          {section === "reports" && !premium && <PremiumGate feature="Le bilan global, les périodes journée/semaine/mois, les marges et les analyses détaillées sont réservés à Premium." onUpgrade={openPremiumRequest} accountInactive={Boolean(user && shop?.estActif !== true)} userId={user?.uid} whatsappUrl={accountActivationUrl} onRefresh={() => void synchronize()} refreshing={syncing} />}
          {section === "settings" && <div className="settings-layout">
            <section className="panel settings-panel">
              <div className="panel-toolbar"><div><h2>Ma boutique</h2><p>Donnez un nom à votre commerce pour le reconnaître facilement.</p></div></div>
              <label>Nom de la boutique<input className="form-input" value={shopName} onChange={(event) => setShopName(event.target.value)} placeholder="Ex. Boutique Awa" /></label>
              <label>Monnaie utilisée<select className="form-input" value={currency} onChange={(event) => setCurrency(event.target.value)}><option value="XOF">Franc CFA BCEAO (FCFA)</option><option value="XAF">Franc CFA BEAC (FCFA)</option><option value="EUR">Euro (EUR)</option><option value="USD">Dollar américain (USD)</option></select></label>
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
              <p>{user ? `Votre compte ${user.isAnonymous ? "anonyme" : "connecté"} synchronise vos données. Le numéro ${shop?.phone ?? user.phoneNumber ?? "de contact"} n’est pas un moyen de connexion et ne permet pas de retrouver le compte sur un autre téléphone.` : "Activez la sauvegarde en ligne pour retrouver vos données sur cet appareil."}</p>
              {user
                ? <><button className="button button-outline" disabled={syncing} onClick={() => void synchronize()}>{syncing ? "Sauvegarde en cours…" : "↻ Sauvegarder maintenant"}</button></>
                : firebaseConfigured
                  ? <button className="button button-outline" onClick={openCloudSync}>Activer la sauvegarde gratuite →</button>
                  : <p className="setup-notice"><strong>Sauvegarde en ligne indisponible.</strong><span>Le service de sauvegarde est momentanément indisponible. Vos données restent enregistrées sur cet appareil.</span></p>}
              <div className="settings-divider" />
              <h2>Compte et synchronisation</h2>
              <p>{user ? `Compte connecté : ${shop?.phone ?? "numéro enregistré"} · Identifiant ${user.uid}. État : ${syncing ? "synchronisation en cours" : syncMessage}.` : "Aucun compte en ligne n’est connecté. Les données sont conservées sur cet appareil."}</p>
              {user && <button className="button button-outline" onClick={async () => { if (auth) await signOut(auth); }}>Se déconnecter</button>}
              <div className="settings-divider" />
              <h2>Installer Bĩngi</h2>
              <p>Ajoutez l’application à l’écran d’accueil pour la retrouver facilement sur ce téléphone.</p>
              <button className="button button-outline" onClick={() => void installApp()}>↓ Installer l’application</button>
            </section>
            <section className={`premium-card ${premium ? "premium-card-on" : ""}`}>
              <span className="premium-spark">✦</span><span className="eyebrow">{premium ? "VOTRE ABONNEMENT" : "BĨNGI PREMIUM"}</span>
              {user && shop?.estActif !== true && <div className="payment-help"><strong>Votre abonnement attend son activation</strong><span>Après vérification de votre paiement, l’administrateur activera votre compte. Votre identifiant : <code>{user.uid}</code>.</span>{accountActivationUrl && <a className="button button-whatsapp request-whatsapp" href={accountActivationUrl} target="_blank" rel="noreferrer">Activer mon abonnement via WhatsApp ↗</a>}<button className="button button-outline" onClick={() => void synchronize()} disabled={syncing}>{syncing ? "Vérification…" : "Vérifier si mon abonnement est activé"}</button></div>}
              <h2>{premium ? "Votre boutique est Premium" : "Des outils avancés pour votre boutique."}</h2>
              <p>{premium ? `Votre accès est actif${shop?.subscriptionExpiresAt ? ` jusqu’au ${dayLabel(shop.subscriptionExpiresAt)}` : ""}. Vous pouvez gérer jusqu’à 3 boutiques avec des stocks et bilans séparés.` : "La gestion quotidienne et la sauvegarde en ligne restent gratuites. Premium ajoute des outils avancés et jusqu’à 3 boutiques."}</p>
              {premium && <div className="shop-management"><strong>{shops.length} / 3 boutiques utilisées</strong>{shops.length < 3 ? <button className="button button-primary" onClick={() => void createBoutique()}>＋ Créer une boutique</button> : <span>Votre compte utilise déjà ses 3 boutiques.</span>}</div>}
              <ul><li>✓ Gratuit : stock, ventes, dépenses et historique complet</li><li>✓ Gratuit : crédits clients et paiements partiels</li><li>✓ Gratuit : bénéfice estimé et sauvegarde en ligne</li><li>✓ Premium : reçu WhatsApp et impression après chaque vente</li><li>✓ Premium : bilans détaillés, plus de 30 articles et jusqu’à 3 boutiques</li></ul>
              {!premium && !(user && shop?.estActif !== true) && <><div className="premium-price">1 000 <small>FCFA pour un mois</small></div><button className="button button-whatsapp" onClick={openPremiumRequest}>Demander Premium →</button><small className="manual-note">Vous payez seulement après avoir reçu les instructions. Paiement vérifié par une personne.</small></>}
            </section>
          </div>}
        </div>
      </main>

      {modal && <div className="modal-backdrop" onClick={() => setModal(null)}><div className={`modal ${modal === "receipt" ? "receipt-modal" : ""}`} onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">BĨNGI · {shopName || "MA BOUTIQUE"}</span><h2>{modal === "product" ? "Ajouter un article" : modal === "sale" ? "Enregistrer une vente" : modal === "expense" ? (editingExpense ? "Modifier une dépense" : "Ajouter une dépense") : modal === "debt" ? (editingDebt ? "Modifier un crédit client" : "Ajouter un crédit client") : modal === "supplier" ? (editingSupplier ? "Modifier le fournisseur" : "Ajouter un fournisseur") : modal === "restock" ? "Réapprovisionner le stock" : modal === "loss" ? "Déclarer une perte de stock" : modal === "debt-payment" ? "Paiement du crédit" : modal === "receipt" ? "Reçu de vente" : modal === "cloud-sync" ? "Sauvegarde en ligne gratuite" : "Passer à Premium"}</h2></div><button className="close-button no-print" onClick={() => setModal(null)} aria-label="Fermer">×</button></div>
        {modal === "product" && <form className="modal-form" onSubmit={(event) => void addProduct(event)}><p className="form-help">Quelques informations suffisent. Vous pourrez ajouter le reste plus tard.</p><label>Nom de l’article<input required autoFocus value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Ex. Riz local, savon, huile…" /></label><label>Prix de vente (FCFA)<input required type="number" min="0" step="1" value={draft.sellingPrice} onChange={(event) => setDraft({ ...draft, sellingPrice: event.target.value })} placeholder="Ex. 1 000" /></label><label>Quantité en boutique<input required type="number" min="0" step="1" value={draft.stock} onChange={(event) => setDraft({ ...draft, stock: event.target.value })} placeholder="Ex. 10" /></label><details className="optional-fields"><summary>Ajouter des détails (facultatif)</summary><div className="optional-field-content"><label>Catégorie<input value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} placeholder="Ex. Alimentation" /></label><label>Prix d’achat (FCFA)<input type="number" min="0" step="1" value={draft.costPrice} onChange={(event) => setDraft({ ...draft, costPrice: event.target.value })} placeholder="Pour calculer les bénéfices" /></label><label>M’avertir quand il en reste<input type="number" min="0" step="1" value={draft.lowStockThreshold} onChange={(event) => setDraft({ ...draft, lowStockThreshold: event.target.value })} /></label></div></details><ModalActions onCancel={() => setModal(null)} submit="Enregistrer l’article" /></form>}
        {modal === "sale" && <form className="modal-form" onSubmit={(event) => void recordSale(event)}><label>Produit<select required value={saleProductId} onChange={(event) => setSaleProductId(event.target.value)}><option value="">Choisir un produit</option>{products.filter((product) => product.stock > 0).map((product) => <option key={product.id} value={product.id}>{product.name} · {product.stock} disponible(s) · {money(product.sellingPrice, currency)}</option>)}</select></label><label>Quantité<input required type="number" min="1" step="1" max={products.find((product) => product.id === saleProductId)?.stock ?? undefined} value={saleQuantity} onChange={(event) => setSaleQuantity(event.target.value)} /></label><label>Mode de paiement<select value={salePaymentMethod} onChange={(event) => setSalePaymentMethod(event.target.value as PaymentMethod)} disabled={Boolean(editingSale)}><option value="cash">Espèces</option><option value="orange_money">Orange Money</option><option value="moov_money">Moov Money</option><option value="credit">Crédit client</option></select></label>{salePaymentMethod === "credit" && !editingSale && <><label>Nom du client<input required value={saleCustomerName} onChange={(event) => setSaleCustomerName(event.target.value)} /></label><label>Téléphone du client (facultatif)<input inputMode="tel" value={saleCustomerPhone} onChange={(event) => setSaleCustomerPhone(event.target.value)} /></label><label>Échéance du crédit<input type="date" value={debtDueDate} onChange={(event) => setDebtDueDate(event.target.value)} /></label></>}{saleProductId && <div className="sale-total">Total estimé <strong>{money((products.find((product) => product.id === saleProductId)?.sellingPrice ?? 0) * Number(saleQuantity), currency)}</strong>{salePaymentMethod === "credit" && <small>Le montant sera ajouté aux crédits clients.</small>}</div>}<ModalActions onCancel={() => setModal(null)} submit="Confirmer la vente" /></form>}
        {modal === "expense" && <form className="modal-form" onSubmit={(event) => void addExpense(event)}><label>Libellé<input required autoFocus value={expenseLabel} onChange={(event) => setExpenseLabel(event.target.value)} placeholder="Ex. Transport, électricité…" /></label><label>Montant ({currency})<input required type="number" min="1" step="1" value={expenseAmount} onChange={(event) => setExpenseAmount(event.target.value)} /></label><label>Payé par<select value={expenseMethod} onChange={(event) => setExpenseMethod(event.target.value as Exclude<PaymentMethod, "credit">)}><option value="cash">Espèces</option><option value="orange_money">Orange Money</option><option value="moov_money">Moov Money</option></select></label><ModalActions onCancel={() => setModal(null)} submit={editingExpense ? "Enregistrer les changements" : "Enregistrer la dépense"} /></form>}
        {modal === "debt" && <form className="modal-form" onSubmit={(event) => void addDebt(event)}><label>Nom du client<input required autoFocus value={debtName} onChange={(event) => setDebtName(event.target.value)} placeholder="Ex. Aïssata" /></label><label>Téléphone du client (facultatif)<input value={debtPhone} onChange={(event) => setDebtPhone(event.target.value)} placeholder="+226 70 00 00 00" inputMode="tel" /></label><label>Montant dû (FCFA)<input required type="number" min="1" step="1" value={debtAmount} onChange={(event) => setDebtAmount(event.target.value)} placeholder="Ex. 5 000" /></label><label>Date limite de paiement<input type="date" value={debtDueDate} onChange={(event) => setDebtDueDate(event.target.value)} /></label><label>Note (facultatif)<textarea value={debtNote} onChange={(event) => setDebtNote(event.target.value)} rows={2} placeholder="Ex. À payer vendredi" /></label><ModalActions onCancel={() => setModal(null)} submit={editingDebt ? "Enregistrer les changements" : "Enregistrer le crédit"} /></form>}
        {modal === "supplier" && <form className="modal-form" onSubmit={(event) => void addSupplier(event)}><label>Nom du fournisseur<input required autoFocus value={supplierName} onChange={(event) => setSupplierName(event.target.value)} /></label><label>Téléphone<input inputMode="tel" value={supplierPhone} onChange={(event) => setSupplierPhone(event.target.value)} /></label><label>Notes<textarea rows={2} value={supplierNote} onChange={(event) => setSupplierNote(event.target.value)} placeholder="Produits fournis, conditions…" /></label><ModalActions onCancel={() => setModal(null)} submit={editingSupplier ? "Enregistrer les changements" : "Enregistrer le fournisseur"} /></form>}
        {modal === "restock" && stockProduct && <form className="modal-form" onSubmit={(event) => void receiveStock(event)}><p className="form-help">Article : <strong>{stockProduct.name}</strong> · Stock actuel : {stockProduct.stock}</p><label>Fournisseur<select value={restockSupplierId} onChange={(event) => setRestockSupplierId(event.target.value)}><option value="">Non précisé</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></label><label>Quantité reçue<input required type="number" min="1" step="1" value={restockQuantity} onChange={(event) => setRestockQuantity(event.target.value)} /></label><label>Coût d’achat unitaire ({currency})<input required type="number" min="0" step="1" value={restockCost} onChange={(event) => setRestockCost(event.target.value)} /></label><label>Montant payé maintenant ({currency})<input type="number" min="0" step="1" value={restockPaid} onChange={(event) => setRestockPaid(event.target.value)} placeholder="Vide = achat payé entièrement" /></label><label>Payé par<select value={restockMethod} onChange={(event) => setRestockMethod(event.target.value as Exclude<PaymentMethod, "credit">)}><option value="cash">Espèces</option><option value="orange_money">Orange Money</option><option value="moov_money">Moov Money</option></select></label><ModalActions onCancel={() => setModal(null)} submit="Enregistrer l’achat et le stock" /></form>}
        {modal === "loss" && stockProduct && <form className="modal-form" onSubmit={(event) => void recordStockLoss(event)}><p className="form-help">Article : <strong>{stockProduct.name}</strong> · Stock disponible : {stockProduct.stock}</p><label>Quantité perdue<input required type="number" min="1" max={stockProduct.stock} step="1" value={lossQuantity} onChange={(event) => setLossQuantity(event.target.value)} /></label><label>Motif de la perte<select required value={lossReason} onChange={(event) => setLossReason(event.target.value)}><option value="">Choisir un motif</option><option value="Casse">Casse</option><option value="Péremption">Péremption</option><option value="Vol">Vol</option><option value="Erreur de stock">Erreur de stock</option><option value="Autre">Autre</option></select></label><ModalActions onCancel={() => setModal(null)} submit="Enregistrer la perte" /></form>}
        {modal === "debt-payment" && selectedDebt && <div className="modal-form">
          <div className="debt-payment-summary"><strong>{selectedDebt.customerName}</strong><span>Montant initial : {money(selectedDebt.amount, currency)}</span><b>Reste à payer : {money(remainingForDebt(selectedDebt), currency)}</b></div>
          {remainingForDebt(selectedDebt) > 0 && <form onSubmit={(event) => void addDebtPayment(event)}>
            <label>Montant reçu (FCFA)<input required autoFocus type="number" min="1" max={remainingForDebt(selectedDebt)} step="1" value={debtPaymentAmount} onChange={(event) => setDebtPaymentAmount(event.target.value)} placeholder="Saisir le paiement reçu" /></label>
            <label>Reçu par<select value={debtPaymentMethod} onChange={(event) => setDebtPaymentMethod(event.target.value as Exclude<PaymentMethod, "credit">)}><option value="cash">Espèces</option><option value="orange_money">Orange Money</option><option value="moov_money">Moov Money</option></select></label>
            <ModalActions onCancel={() => setModal(null)} submit="Enregistrer le paiement" />
          </form>}
          <div className="payment-history"><h3>Paiements déjà reçus</h3>
            {debtPayments.filter((payment) => payment.debtId === selectedDebt.id).length
              ? debtPayments.filter((payment) => payment.debtId === selectedDebt.id).map((payment) => <div className="payment-history-row" key={payment.id}><span>{dayLabel(payment.createdAt)}</span><strong>{money(payment.amount, currency)}</strong></div>)
              : <p>Aucun paiement enregistré pour le moment.</p>}
          </div>
          {remainingForDebt(selectedDebt) === 0 && <button className="button button-outline" onClick={() => setModal(null)}>Fermer</button>}
        </div>}
        {modal === "supplier-payment" && selectedPurchase && <form className="modal-form" onSubmit={(event) => void addSupplierPayment(event)}><p className="form-help">Achat : {selectedPurchase.productName} chez {selectedPurchase.supplierName}. Reste dû : <strong>{money(outstandingSupplierByPurchase(selectedPurchase), currency)}</strong></p><label>Montant du règlement ({currency})<input required autoFocus type="number" min="1" max={outstandingSupplierByPurchase(selectedPurchase)} step="1" value={supplierPaymentAmount} onChange={(event) => setSupplierPaymentAmount(event.target.value)} /></label><label>Payé par<select value={supplierPaymentMethod} onChange={(event) => setSupplierPaymentMethod(event.target.value as Exclude<PaymentMethod, "credit">)}><option value="cash">Espèces</option><option value="orange_money">Orange Money</option><option value="moov_money">Moov Money</option></select></label><ModalActions onCancel={() => { setSelectedPurchase(null); setModal(null); }} submit="Enregistrer le règlement" /></form>}
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
          {user && !user.isAnonymous
            ? <>
                {shop?.estActif === true
                  ? <div className="payment-help"><strong>Renouveler mon abonnement</strong><span>Envoyez votre demande sur WhatsApp. Nous vous confirmerons les instructions de paiement.</span></div>
                  : <div className="payment-help"><strong>Activation de l’abonnement en attente</strong><span>Votre compte est créé. Envoyez votre identifiant par WhatsApp pour demander l’activation après paiement.</span><span>Votre identifiant : <code>{user.uid}</code></span></div>}
                <p className="verified-phone">Numéro de contact (non vérifié) : {shop?.phone ?? user.phoneNumber ?? "non renseigné"}</p>
                {authMessage && <p className="auth-message" role="status">{authMessage}</p>}
                <a className="button button-whatsapp request-whatsapp" href={accountActivationUrl} target="_blank" rel="noreferrer">Activer mon abonnement via WhatsApp ↗</a>
                <button className="button button-outline" onClick={() => void synchronize()} disabled={syncing}>{syncing ? "Vérification…" : "Vérifier mon activation"}</button>
                      <button className="text-button premium-cancel" onClick={() => setModal(null)}>Continuer gratuitement</button>
              </>
            : <>
                <p className="request-intro">Créez ou retrouvez votre compte avec un numéro et un code secret. Une demande Premium ouvre ensuite WhatsApp.</p>
                <label>Votre numéro de téléphone<input autoFocus value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+226 70 00 00 00" inputMode="tel" autoComplete="tel" /></label>
                <label>Code secret<input type="password" value={accountPassword} onChange={(event) => setAccountPassword(event.target.value.replace(/\D/g, "").slice(0, 12))} placeholder="6 à 12 chiffres" inputMode="numeric" autoComplete={authMode === "login" ? "current-password" : "new-password"} /></label>
                <small className="phone-format-hint">Vous pouvez saisir 8 chiffres ou le numéro complet avec +226.</small>
                <small className="phone-format-hint">Sans SMS, le numéro n’est pas vérifié. Le code n’est pas envoyé sur WhatsApp.</small>
                {authMessage && !user && <p className="auth-message" role="status">{authMessage}</p>}
                {firebaseConfigured
                  ? <button className="button button-primary" disabled={authBusy || migrationBusy || !phone || !accountPassword} onClick={() => void createAccountWithoutSms()}>{authBusy ? "Connexion…" : migrationBusy ? "Préparation de la boutique…" : authMode === "login" ? "Me connecter et ouvrir WhatsApp" : "Créer mon compte et ouvrir WhatsApp"}</button>
                  : <div className="setup-notice"><strong>La création de compte n’est pas disponible.</strong><span>Réessayez plus tard ou continuez gratuitement sur cet appareil.</span></div>}
                <button className="text-button" onClick={() => { setAuthMode(authMode === "register" ? "login" : "register"); setAuthMessage(""); }}>{authMode === "register" ? "J’ai déjà un compte — me connecter" : "Créer un compte"}</button>
                <p className="whatsapp-hint">{firebaseConfigured ? (normalizedPhone ? "Le numéro sert uniquement de contact; l’activation se fait après vérification WhatsApp." : "Saisissez un numéro burkinabè valide pour continuer.") : "La création de compte est momentanément indisponible. Réessayez plus tard."}</p>
                <div className="payment-help"><strong>Comment se passe le paiement ?</strong><span>N’envoyez pas d’argent avant d’avoir reçu les instructions via WhatsApp.</span></div>
                <button className="text-button premium-cancel" onClick={() => setModal(null)}>Pas maintenant — continuer gratuitement</button>
              </>}
        </div>}
        {modal === "cloud-sync" && <div className="premium-request">
          <p className="request-intro">Synchronisez gratuitement votre stock et vos ventes en ligne. Pour transférer les données vers un nouveau téléphone, téléchargez une sauvegarde puis restaurez-la sur le nouvel appareil.</p>
          {(!user || user.isAnonymous) && <>
            <label>Votre numéro de téléphone<input autoFocus value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+226 70 00 00 00" inputMode="tel" autoComplete="tel" /></label>
            <label>Code secret<input type="password" value={accountPassword} onChange={(event) => setAccountPassword(event.target.value.replace(/\D/g, "").slice(0, 12))} placeholder="6 à 12 chiffres" inputMode="numeric" autoComplete={authMode === "login" ? "current-password" : "new-password"} /></label>
            <small className="phone-format-hint">Sans SMS, le numéro n’est pas vérifié. Mémorisez votre code pour retrouver le compte.</small>
            {authMessage && <p className="auth-message" role="status">{authMessage}</p>}
            <button className="button button-primary" disabled={authBusy || migrationBusy || !phone || !accountPassword} onClick={() => void createAccountWithoutSms()}>{authBusy ? "Connexion…" : migrationBusy ? "Préparation de la boutique…" : authMode === "login" ? "Me connecter et synchroniser" : "Créer mon compte et synchroniser"}</button>
            <button className="text-button" onClick={() => { setAuthMode(authMode === "register" ? "login" : "register"); setAuthMessage(""); }}>{authMode === "register" ? "J’ai déjà un compte — me connecter" : "Créer un compte"}</button>
          </>}
          {user && !user.isAnonymous && <>
            <p className="verified-phone">Compte en ligne : {shop?.phone ?? "numéro enregistré"}</p>
            <p className="phone-format-hint">Connectez-vous avec votre numéro et votre code secret sur un autre téléphone.</p>
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

function ProductsTable({ products, currency, premium, onRestock, onLoss, onEdit, onDelete }: {
  products: Product[];
  currency: string;
  premium: boolean;
  onRestock: (product: Product) => void;
  onLoss: (product: Product) => void;
  onEdit: (product: Product) => void;
  onDelete: (product: Product) => void;
}) {
  if (!products.length) return <Empty message="Aucun produit pour le moment" detail="Ajoutez vos produits pour commencer à suivre le stock." />;
  return <div className="table-wrap"><table><thead><tr><th>PRODUIT</th><th>CATÉGORIE</th><th>PRIX D’ACHAT</th><th>PRIX DE VENTE</th><th>MARGE / UNITÉ</th><th>STOCK</th><th>STATUT</th><th>ACTIONS</th></tr></thead><tbody>{products.map((product) => { const margin = product.sellingPrice > 0 ? ((product.sellingPrice - product.costPrice) / product.sellingPrice) * 100 : 0; return <tr key={product.id}><td><div className="table-product"><div className="product-placeholder">{product.name.slice(0, 1).toUpperCase()}</div><strong>{product.name}</strong></div></td><td>{product.category || "—"}</td><td>{money(product.costPrice, currency)}</td><td className="strong-cell">{money(product.sellingPrice, currency)}</td><td><strong>{product.costPrice > 0 ? money(product.sellingPrice - product.costPrice, currency) : "Coût à compléter"}</strong><small className="margin-rate">{product.costPrice > 0 ? `${margin.toFixed(1)} % de marge` : "Bénéfice non calculable"}</small></td><td>{product.stock}</td><td><span className={`status ${product.stock <= product.lowStockThreshold ? "status-low" : "status-ok"}`}>{product.stock <= product.lowStockThreshold ? "Stock faible" : "En stock"}</span></td><td><button className="small-action" onClick={() => onRestock(product)}>{premium ? "Réapprovisionner" : "Réapprovisionner · PRO"}</button>{" "}<button className="small-action" onClick={() => onLoss(product)}>{premium ? "Déclarer une perte" : "Pertes · PRO"}</button>{" "}<button className="small-action" onClick={() => onEdit(product)}>Modifier</button>{" "}<button className="small-action" onClick={() => onDelete(product)}>Supprimer</button></td></tr>; })}</tbody></table></div>;
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
  return <div className="table-wrap"><table><thead><tr><th>RÉFÉRENCE</th><th>DATE</th>{!compact && <th>ARTICLES</th>}<th>MONTANT</th><th>PAIEMENT</th><th>STATUT</th>{onReceipt && <th>REÇU</th>}{(onEdit || onDelete) && <th>ACTIONS</th>}</tr></thead><tbody>{sales.map((sale) => <tr key={sale.id}><td className="mono">#{sale.id.slice(0, 7).toUpperCase()}</td><td>{dayLabel(sale.createdAt)}</td>{!compact && <td>{sale.items.reduce((sum, item) => sum + item.quantity, 0) || "—"}</td>}<td className="strong-cell">{money(sale.total, currency)}</td><td>{paymentLabel(sale.paymentMethod)}{sale.paymentMethod === "credit" && sale.customerName ? ` · ${sale.customerName}` : ""}</td><td><span className={`status ${sale.paymentMethod === "credit" ? "status-low" : "status-ok"}`}>{sale.paymentMethod === "credit" ? "Crédit client" : "Payée"}</span></td>{onReceipt && <td><button className="small-action no-print" onClick={() => onReceipt(sale)}>{premium ? "Voir le reçu" : "Reçu · Premium"}</button></td>}{(onEdit || onDelete) && <td>{onEdit && <button className="small-action" onClick={() => onEdit(sale)}>Modifier</button>}{" "}{onDelete && <button className="small-action" onClick={() => onDelete(sale)}>Supprimer</button>}</td>}</tr>)}</tbody></table></div>;
}

function ExpenseTable({ expenses, currency, onEdit, onDelete }: { expenses: Expense[]; currency: string; onEdit: (expense: Expense) => void; onDelete: (expense: Expense) => void }) {
  if (!expenses.length) return <Empty message="Aucune dépense enregistrée" detail="Ajoutez vos dépenses pour suivre votre bénéfice net." />;
  return <div className="table-wrap"><table><thead><tr><th>LIBELLÉ</th><th>DATE</th><th>MONTANT</th><th>ACTIONS</th></tr></thead><tbody>{expenses.map((expense) => <tr key={expense.id}><td className="strong-cell">{expense.label}</td><td>{dayLabel(expense.createdAt)}</td><td>{money(expense.amount, currency)}</td><td><button className="small-action" onClick={() => onEdit(expense)}>Modifier</button>{" "}<button className="small-action" onClick={() => onDelete(expense)}>Supprimer</button></td></tr>)}</tbody></table></div>;
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
  return <div className="table-wrap"><table><thead><tr><th>CLIENT</th><th>TÉLÉPHONE</th><th>NOTE</th><th>DATE</th><th>ÉCHÉANCE / ALERTE</th><th>MONTANT INITIAL</th><th>RESTE DÛ</th><th>ACTIONS</th></tr></thead><tbody>{debts.map((debt) => { const remaining = remainingForDebt(debt); const overdue = isDebtOverdue(debt, remaining); return <tr key={debt.id}><td className="strong-cell">{debt.customerName}</td><td>{debt.phone || "—"}</td><td>{debt.note || "—"}</td><td>{dayLabel(debt.createdAt)}</td><td>{debt.dueDate ? <><span>{dayLabel(`${debt.dueDate}T12:00:00`)}</span>{overdue && <small className="overdue-label">En retard</small>}</> : "Non définie"}</td><td>{money(debt.amount, currency)}</td><td className="debt-amount">{money(remaining, currency)}</td><td><button className="small-action" onClick={() => onPayment(debt)}>{remaining ? "Paiements" : "Voir paiements"}</button>{" "}<button className="small-action" onClick={() => onEdit(debt)}>Modifier</button>{" "}<button className="small-action" onClick={() => onDelete(debt)}>Supprimer</button></td></tr>; })}</tbody></table></div>;
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
  return <section className="locked-panel"><span className="lock-icon">✦</span><span className="eyebrow">{accountInactive ? "ACTIVATION EN ATTENTE" : "FONCTIONNALITÉ PREMIUM"}</span><h2>{accountInactive ? "Votre abonnement n’est pas encore activé." : "Débloquez ces outils pour votre boutique."}</h2><p>{feature}</p><p>{accountInactive ? "Après vérification de votre paiement, l’administrateur activera votre abonnement. L’offre gratuite reste disponible pendant l’attente." : "Premium coûte 1 000 FCFA pour un mois. Vous pouvez continuer à enregistrer vos ventes gratuitement."}</p>{accountInactive && userId && <p>Identifiant du compte : <code>{userId}</code></p>}{accountInactive && whatsappUrl ? <a className="button button-whatsapp" href={whatsappUrl} target="_blank" rel="noreferrer">Activer mon abonnement via WhatsApp ↗</a> : !accountInactive && <button className="button button-primary" onClick={onUpgrade}>Découvrir Premium →</button>}{accountInactive && <button className="button button-outline" onClick={onRefresh} disabled={refreshing}>{refreshing ? "Vérification…" : "Vérifier mon activation"}</button>}</section>;
}
