# Bĩngi — gestion de stock et des ventes

Application de gestion de boutique, en français, installable comme PWA et pensée pour les commerces au Burkina Faso. L’offre gratuite fonctionne immédiatement sans compte avec IndexedDB (Dexie) et reste utilisable hors ligne. Une sauvegarde en ligne gratuite et facultative utilise Firebase Authentication anonyme et Cloud Firestore; le numéro saisi n’est pas vérifié et ne permet pas de retrouver une session sur un autre appareil.

## Fonctionnalités

- Catalogue de produits, prix d’achat/de vente, seuils d’alerte et réapprovisionnement.
- Enregistrement des ventes avec déduction du stock.
- Dépenses et historique complet des ventes accessibles gratuitement.
- Bénéfice estimé du jour accessible gratuitement, calculé à partir des prix d’achat renseignés.
- Reçus après vente (partage WhatsApp/impression), crédits clients avec paiements partiels et bilans détaillés réservés à Premium.
- Export/import JSON avec rappel de sauvegarde guidé.
- L’offre gratuite fonctionne sans compte; la limite gratuite est de 30 articles.
- Premium à 1 000 FCFA/mois : reçus, crédits clients, bilans et plus de 30 articles. Activation du paiement gérée manuellement via WhatsApp.
- Synchronisation hors ligne en file d’attente locale; envoi à Firestore au retour du réseau.

## Prérequis

- Node.js 22 ou plus récent.
- Un projet Firebase avec Cloud Firestore activé.
- Firebase Authentication avec le fournisseur **Anonyme** activé.

L’utilisation locale gratuite ne demande ni compte ni numéro. La sauvegarde en ligne et la demande Premium utilisent une session Firebase anonyme créée après la saisie du numéro, sans SMS. Le numéro est enregistré comme contact non vérifié et ne permet pas de récupérer une session anonyme sur un nouvel appareil. Sans connexion à un compte, les données restent sur l’appareil; utilisez régulièrement l’export de sauvegarde pour éviter les pertes en cas de changement ou de panne de téléphone.

## Configuration Firebase / Firestore

1. Créez un projet Firebase et une application Web dans la console Firebase.
2. Dans **Firestore Database**, créez la base Cloud Firestore en mode production.
3. Copiez `.env.example` vers `.env.local` et ajoutez les valeurs de l’application Web Firebase (`NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID`). Choisissez aussi l’identifiant de projet dans `.firebaserc`.
4. Dans **Authentication > Sign-in method**, activez **Anonyme**. Aucun code SMS n’est utilisé pour créer le compte; le numéro saisi est un contact non vérifié.
5. Déployez les règles d’accès Firestore :

   ```bash
   npm install
   firebase login
   firebase use --add
   npm run firestore:deploy
   ```

   Après saisie du numéro, Firebase Auth crée une session anonyme et un profil est créé dans `users/{uid}` avec `uid`, le numéro fourni et `estActif: false`. Les règles permettent au commerçant de créer son profil inactif, mais seul l’administrateur peut ensuite modifier `estActif`. Les données restent isolées dans les sous-collections de chaque UID; les sous-collections Premium `debts` et `debtPayments` sont inaccessibles tant que `estActif` n’est pas `true`.

6. Lancez l’application :

   ```bash
   npm run dev
   ```

Pour tester en local avec les émulateurs :

```bash
npm run firestore:emulators
```

Mettez `NEXT_PUBLIC_USE_FIREBASE_EMULATORS=true` dans `.env.local`, puis démarrez l’application dans un autre terminal. Pour Vercel, reportez-y les variables d’environnement Firebase avant de déployer le site.

## Développement

```bash
npm run lint
npm run typecheck
npm run build
```

## Offre Premium et validation des paiements

Le commerçant peut continuer à utiliser les fonctions gratuites sans compte. Pour demander Premium ou activer la synchronisation en ligne, il saisit son numéro, sans mot de passe ni code SMS. Firebase Auth crée une session anonyme; l’application enregistre le numéro comme contact non vérifié et crée le profil Firestore `users/{uid}` avec `uid` et `estActif: false`. Lors d’une demande Premium, après l’enregistrement du profil et la synchronisation des données locales, Bĩngi ouvre automatiquement [le contact WhatsApp de Bĩngi](https://wa.me/message/SQXBCLHS6SBXN1) avec un message prérempli contenant l’UID Firebase. Les fonctionnalités gratuites restent accessibles pendant l’attente. Après vérification manuelle du paiement de 1 000 FCFA, l’administrateur ouvre le document correspondant dans Firestore et passe `estActif` à `true`. L’application vérifie le profil à la prochaine synchronisation et débloque Premium. Pour suspendre l’accès, repasser `estActif` à `false`. Ne faites jamais cette activation depuis le client : les règles Firestore interdisent à l’utilisateur de modifier ce champ.

Premium donne accès aux reçus de vente (partage WhatsApp et impression), aux crédits clients et paiements partiels, aux bilans et rapports, ainsi qu’à plus de 30 articles. La sauvegarde et la synchronisation en ligne sont disponibles gratuitement après saisie d’un numéro, sans vérification SMS. Les opérations de paiement et d’abonnement doivent rester validées côté administration; le statut local de l’interface seul ne constitue pas une protection anti-fraude. Un compte en attente conserve l’accès à toutes les fonctions gratuites.

## Synchronisation et limites

Les modifications sont d’abord enregistrées dans IndexedDB, puis synchronisées avec Firestore quand l’utilisateur est connecté et que l’appareil est en ligne, qu’il soit gratuit ou Premium. La sauvegarde en ligne gratuite est facultative : elle s’active dans Paramètres avec le numéro de téléphone, sans vérification SMS. Lors de la première connexion, les données locales sont copiées vers la session Firebase anonyme; la synchronisation reprend automatiquement au retour du réseau. Une session anonyme est liée à cet appareil et ne peut pas être retrouvée avec le numéro seul; le numéro n’est pas vérifié.

Le changement d’appareil d’un utilisateur gratuit se fait avec une sauvegarde JSON : téléchargez le fichier sur l’ancien téléphone, transférez-le, puis utilisez « Récupérer une sauvegarde » dans les paramètres du nouveau téléphone. Les mises à jour concurrentes du stock sur plusieurs appareils ne sont pas réconciliées automatiquement.

Les dossiers `dataconnect/` et `src/dataconnect-generated/` sont des artefacts de l’ancienne configuration SQL/Data Connect; la version actuelle de Bĩngi utilise Firestore et ne les charge plus dans l’application.
