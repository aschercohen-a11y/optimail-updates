# OptiMail — serveur de mises a jour

Distribue les versions d'OptiMail a l'application installee, et accepte le
depot d'une nouvelle version.

Deploye sur <https://optimail.swipego.app> (serveur OVH `217.182.89.133`, via
Coolify).

## Routes

| Methode | Chemin | Acces | Role |
|---|---|---|---|
| `GET` | `/latest.yml` | public | Index lu par l'application pour savoir s'il existe une version plus recente |
| `GET` | `/OptiMail-Setup-<version>.exe` | public | Telechargement de l'installeur |
| `PUT` | `/publish/<fichier>` | jeton | Depot d'une nouvelle version |

La lecture est publique : un installeur n'est pas un secret, et l'application
doit pouvoir l'atteindre sans identifiants. Seul le depot est protege.

## Configuration

| Variable | Role |
|---|---|
| `UPLOAD_TOKEN` | Jeton exige pour deposer. **Sans lui, tout depot est refuse.** |
| `DATA_DIR` | Dossier des fichiers publies (`/data`, monte en volume persistant) |
| `PORT` | Port d'ecoute (3000) |

## Garde-fous

- Seules les extensions `.exe`, `.yml` et `.blockmap` sont acceptees : le
  service ne doit pas devenir un hebergeur de fichiers quelconque.
- Les noms de fichiers sont valides avant toute ecriture — aucun chemin
  relatif ne peut sortir de `DATA_DIR`.
- Depot ecrit sous un nom temporaire puis renomme : une coupure de reseau ne
  laisse jamais un installeur tronque a la place du bon.
- Comparaison du jeton a duree constante.
- 500 Mo par fichier au maximum.

## Publier depuis le poste de developpement

Depuis le depot d'OptiMail :

```bash
npm run publish:update
```

Le script envoie l'installeur, son `blockmap` et `latest.yml` produits par
`npm run dist`. Il attend la variable d'environnement `OPTIMAIL_UPLOAD_TOKEN`.
