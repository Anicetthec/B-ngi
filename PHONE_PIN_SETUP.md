# Connexion, données et caisse

## Numéro et code secret

À chaque ouverture, l’application demande un numéro et un code secret. Aucun SMS ni e-mail n’est envoyé : le numéro devient un identifiant technique Firebase Authentication (`numéro@phone.bingi.app`) et Firebase gère le code comme un mot de passe. Le numéro n’est pas vérifié. Il faut mémoriser le code; il n’existe pas de récupération automatique.

## Données hors ligne et synchronisation

- Produits, ventes, dépenses, crédits et paiements, achats, fournisseurs, pertes, mouvements et clôtures de caisse sont stockés dans IndexedDB sur l’appareil.
- Pendant que l’application reste ouverte sans réseau, les modifications sont gardées localement et envoyées à Firestore au retour d’Internet.
- Avec Premium actif, fournisseurs, achats, règlements fournisseurs et pertes sont également synchronisés. Caisse, ventes, dépenses et autres données standard sont synchronisées avec le compte.
- **Limite :** Firebase doit vérifier le numéro/code à chaque ouverture. Après fermeture ou rechargement sans Internet, l’écran de connexion bloque l’accès aux données locales. L’ouverture hors ligne n’est pas implémentée.

## Paiements et calculs

- Une vente peut être réglée en espèces, Orange Money, Moov Money ou à crédit. Une vente à crédit crée un dossier client associé; ses remboursements peuvent être encaissés par les trois canaux.
- Un achat fournisseur se crée depuis **Produits & stock → Réapprovisionner**. Il enregistre la quantité, le coût, le fournisseur et le montant payé. Le reste dû peut être payé depuis **Achats fournisseurs**.
- Le coût du stock est actualisé selon le coût moyen pondéré des quantités en stock et reçues. La vente garde une copie du coût au moment de la transaction.
- L’écran **Caisse** calcule le solde attendu depuis le fond de caisse, les ventes encaissées, remboursements, dépenses, paiements d’achats et mouvements enregistrés. Il permet d’enregistrer l’argent réellement compté et l’écart.
- Les marges et le bénéfice net sont des estimations si le prix d’achat ou une dépense manque. Rotation du stock et seuil de rentabilité sont aussi indicatifs; un stock initial ou des corrections d’inventaire non saisis peuvent fausser l’estimation.
- Les anciennes ventes sans mode de paiement sont interprétées comme des ventes en espèces. Les anciens réapprovisionnements ne créent pas rétroactivement de lignes d’achat.

## Activation Premium manuelle

1. L’utilisateur s’inscrit ou se connecte dans l’application.
2. Dans **Paramètres → Premium**, il appuie sur **« Je veux activer Premium »**. WhatsApp ouvre un message contenant son numéro de contact, le nom de boutique et son UID Firebase. Il doit encore appuyer sur **Envoyer**.
3. Après vérification du paiement, dans Firebase Console → **Firestore Database → Data**, ouvrir `users/{UID}` et passer le champ booléen `estActif` à `true`.
4. L’utilisateur revient dans l’application et choisit **« Vérifier si mon abonnement est activé »**.

Les règles empêchent l’utilisateur de modifier lui-même `estActif`.

## Configurer et publier Firebase

Le projet sélectionné par `.firebaserc` est `zambo-6b504`.

1. Dans Firebase Console → **Authentication → Sign-in method**, activer **E-mail/Mot de passe**.
2. Créer Cloud Firestore si nécessaire.
3. Vérifier que `.env.local` contient les clés Web Firebase du projet `zambo-6b504` : `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID` et `NEXT_PUBLIC_FIREBASE_APP_ID`.
4. Publier les règles à jour depuis le dossier du projet :

   ```bash
   firebase login
   firebase use zambo-6b504
   npm run firestore:deploy
   ```

La commande publie uniquement `firestore.rules`, y compris les nouvelles permissions Premium sur `purchases` et `supplierPayments`. Elle ne déploie pas l’interface Next.js. Les modifications du site doivent être publiées séparément sur un hébergeur Next.js. Le `firebase.json` actuel ne déclare aucune cible Hosting.
