# Bingii — gestion de stock et des ventes

Application de gestion de boutique, en français, installable comme PWA et pensée pour les commerces au Burkina Faso. L’accès exige un compte avec numéro et code secret (sans SMS). Les données et opérations sont conservées localement et synchronisées quand le réseau est disponible.

## Fonctionnalités

- Catalogue de produits, prix d’achat/de vente, seuils d’alerte et réapprovisionnement.
- Ventes payées en espèces, Orange Money, Moov Money ou à crédit, avec création d’un crédit client relié à la vente.
- Journal des achats lors du réapprovisionnement, coût moyen pondéré du stock, paiements et soldes dus aux fournisseurs (Premium).
- Caisse journalière : fond de caisse, mouvements, encaissements et sorties par canal, clôture et écart entre solde attendu et espèces comptées.
- Dépenses et historique complet des ventes accessibles gratuitement.
- Bénéfice estimé du jour accessible gratuitement, calculé à partir des prix d’achat renseignés.
- Reçus après vente (partage WhatsApp/impression), crédits clients avec paiements partiels et bilans détaillés réservés à Premium.
- Export/import JSON avec rappel de sauvegarde guidé.
- L’offre gratuite fonctionne sans compte; la limite gratuite est de 30 articles.
- Premium à 2 000 FCFA/mois : reçus, crédits clients, bilans et plus de 30 articles. Activation du paiement gérée manuellement via WhatsApp.
- Synchronisation hors ligne en file d’attente locale; envoi à Firestore au retour du réseau.
- Bilans avec marge brute en %, meilleures ventes, stocks sans vente récente, rotation estimée, créances en retard et seuil de rentabilité estimé.

## Prérequis

- Node.js 22 ou plus récent.
- Un projet Firebase avec Cloud Firestore activé.
- Firebase Authentication avec le fournisseur **E-mail/Mot de passe** activé.

Le formulaire de compte apparaît à chaque ouverture de l’application. Il accepte l’inscription ou la connexion avec un numéro et un code de 6 à 12 chiffres. Le code est géré par Firebase Authentication; le numéro est transformé en identifiant technique et n’est pas vérifié. Il faut mémoriser le code : aucun SMS, courriel de récupération ni code secret en clair ne sont utilisés. La connexion demande Internet à chaque ouverture avec le parcours actuel.

## Configuration Firebase / Firestore

1. Créez un projet Firebase et une application Web dans la console Firebase.
2. Dans **Firestore Database**, créez la base Cloud Firestore en mode production.
3. Copiez `.env.example` vers `.env.local` et ajoutez les valeurs de l’application Web Firebase (`NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID`). Choisissez aussi l’identifiant de projet dans `.firebaserc`.
4. Dans **Authentication > Sign-in method**, activez **E-mail/Mot de passe**. Le numéro est converti en adresse technique `...@phone.bingi.app` pour que Firebase Auth puisse gérer le code sans envoyer d’e-mail ou de SMS. Activez aussi **Anonyme** uniquement si d’anciennes sessions anonymes doivent encore être utilisées.
5. Déployez les règles d’accès Firestore :

   ```bash
   npm install
   firebase login
   firebase use zambo-6b504
   npm run firestore:deploy
   ```

   À l’inscription, Firebase Auth crée l’utilisateur. Le profil Firestore `users/{uid}` enregistre le numéro, le nom de boutique et `estActif: false`; le code secret n’est pas écrit dans Firestore. Les règles interdisent à l’utilisateur de modifier `estActif`.

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

Un compte se retrouve sur un autre appareil avec le même numéro et le même code, avec Internet. Sans SMS, le numéro n’est pas vérifié et un code oublié ne peut pas être récupéré automatiquement. « Je veux activer Premium » ouvre [le contact WhatsApp de Bingii](https://wa.me/message/SQXBCLHS6SBXN1) avec le numéro de contact et l’UID Firebase préremplis; l’utilisateur doit appuyer sur Envoyer. Après vérification manuelle du paiement, l’administrateur passe `users/{uid}.estActif` à `true` dans Firestore.

Premium donne accès aux reçus de vente (partage WhatsApp et impression), aux crédits clients et paiements partiels, aux bilans et rapports, ainsi qu’à plus de 30 articles. La sauvegarde et la synchronisation en ligne sont disponibles gratuitement après saisie d’un numéro, sans vérification SMS. Les opérations de paiement et d’abonnement doivent rester validées côté administration; le statut local de l’interface seul ne constitue pas une protection anti-fraude. Un compte en attente conserve l’accès à toutes les fonctions gratuites.

## Synchronisation et limites

Les produits, ventes, dépenses, crédits/paiements, clôtures et mouvements de caisse sont enregistrés dans IndexedDB puis synchronisés avec Firestore lorsque l’application est ouverte et le réseau disponible. Les fournisseurs, achats/règlements et pertes sont synchronisés avec Premium actif. Les ventes historiques sans mode de paiement sont considérées comme encaissées en espèces. Le coût du stock est recalculé par moyenne pondérée lors des achats; le bénéfice, la rotation et le seuil de rentabilité restent estimatifs, notamment si le stock initial ou des corrections n’ont pas été enregistrés. Après fermeture ou rechargement hors ligne, l’écran de connexion bloque l’accès : l’ouverture hors ligne n’est pas encore prise en charge.

Les changements de fichiers TypeScript/React ne sont pas envoyés à Firestore : ils doivent être publiés séparément sur l’hébergeur de l’application. Les règles Firestore se déploient séparément avec `npm run firestore:deploy`.

Le changement d’appareil d’un utilisateur gratuit se fait avec une sauvegarde JSON : téléchargez le fichier sur l’ancien téléphone, transférez-le, puis utilisez « Récupérer une sauvegarde » dans les paramètres du nouveau téléphone. Les mises à jour concurrentes du stock sur plusieurs appareils ne sont pas réconciliées automatiquement.

Les dossiers `dataconnect/` et `src/dataconnect-generated/` sont des artefacts de l’ancienne configuration SQL/Data Connect; la version actuelle de Bingii utilise Firestore et ne les charge plus dans l’application.
