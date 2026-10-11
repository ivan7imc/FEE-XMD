# FEE-XMD no Render + Neon (PostgreSQL)

Guia passo a passo para rodar o bot no [Render](https://render.com) usando o
[Neon](https://neon.tech) como banco de dados.

> O Render tem **filesystem efêmero**: tudo o que o bot grava em disco some a
> cada restart/redeploy. Por isso este deploy guarda **tudo no Neon**:
> configurações, grupos, warns, histórico **e a própria sessão do WhatsApp**.
> Assim o bot reconecta sozinho depois de qualquer restart, sem precisar
> parear de novo.

---

## 0. ⚠️ Antes de tudo: informe o SEU número

O `index.js` original vem com o número do autor **fixo no código**
(`255752593977`). Ele é usado para duas coisas:

1. pedir o **pairing code** no primeiro boot;
2. decidir quem é o **dono** do bot (`isDevNumber`) — ou seja, quem pode usar
   os comandos de owner.

Sem configurar, o bot vai gerar um código de pareamento para o número do
autor e vai tratar o autor como dono. Para evitar isso este fork lê as
variáveis abaixo:

| Variável         | Para que serve                                                    |
| ---------------- | ----------------------------------------------------------------- |
| `OWNER_NUMBER`   | **seu** número (formato internacional, só dígitos) — vira o dono   |
| `DEV_NUMBER`     | alias de `OWNER_NUMBER` (compatibilidade)                          |
| `PAIR_NUMBER`    | número usado no pairing code (se omitido, usa o `OWNER_NUMBER`)    |
| `PAIRING_NUMBER` | alias de `PAIR_NUMBER`                                             |

Ordem de precedência:
`PAIR_NUMBER` → `PAIRING_NUMBER` → `OWNER_NUMBER` → `DEV_NUMBER` → valor do
código original.

Exemplo (Brasil, +55 31 99988-7766):

```
OWNER_NUMBER=5531999887766
```

> O `render.yaml` já declara `OWNER_NUMBER` e `PAIR_NUMBER` como
> `sync: false`, então o Render pede os dois na hora de aplicar o Blueprint —
> preencha pelo menos o `OWNER_NUMBER`.

---

## 1. Criar o banco no Neon

1. Crie uma conta em <https://neon.tech> e um **Project**.
2. **Region:** escolha a região mais próxima do seu serviço no Render
   (`Oregon` no Render = `AWS us-west-2` no Neon — deixei `oregon` no
   `render.yaml`).
3. Abra o projeto e copie a **connection string "Pooled connection"**, ela é
   assim:

   ```
   postgresql://<user>:<password>@ep-xxxx-pooler.us-west-2.aws.neon.tech/neondb?sslmode=require
   ```

   * Use a **pooled** (termina em `-pooler`), é a recomendada para aplicações
     serverless/connection pool.
   * Mantenha o `?sslmode=require` — o Neon exige TLS.
   * ⚠️ O pool do bot abre no máximo 5 conexões, então o pooler do Neon casa
     perfeitamente com o plano free.

4. **Não** precisa rodar migrations: o bot cria as tabelas sozinho no primeiro
   boot (`settings`, `group_settings`, `sudo_users`, `banned_users`,
   `conversation_history`, `warn_data`, `lid_phone`, `msg_store` e
   `whatsapp_auth`, onde fica a sessão).

---

## 2. Subir no Render

### Opção A — Blueprint (recomendado, um clique)

O arquivo [`render.yaml`](../render.yaml) na raiz já descreve tudo.

1. Faça um fork/commit deste repositório no GitHub.
2. No Render: **New +** → **Blueprint** → selecione o repositório.
3. O Render lê o `render.yaml` e mostra a variável `DATABASE_URL` como
   pendente → **cole a connection string do Neon**.
4. Clique em **Apply**. O build roda:

   ```
   apt-get install ffmpeg (best-effort)
   npm install
   node patch-baileys.js
   ```

   e o start é `node index.js`.

### Opção B — Web Service manual

| Campo           | Valor                                    |
| --------------- | ---------------------------------------- |
| Runtime         | `Node`                                   |
| Build Command   | `npm install --no-audit --no-fund && node patch-baileys.js` |
| Start Command   | `node index.js`                          |
| Health Check    | `/health`                                |
| Plan            | `Free` (ou `Starter` para ficar 24/7)    |

Variáveis de ambiente:

| Key             | Value                                                    |
| --------------- | -------------------------------------------------------- |
| `NODE_VERSION`  | `22`                                                     |
| `NODE_ENV`      | `production`                                             |
| `DATABASE_URL`  | connection string **pooled** do Neon (`?sslmode=require`) |
| `PORT`          | `10000` (o Render também injeta sozinho)                 |
| `SESSION_STORE` | `auto` (Postgres; `file` = pasta `Session/`)             |
| `SESSION_NAME`  | `default` (use outro nome se rodar 2 bots no mesmo banco) |
| `BOTNAME`       | `FEE-XMD`                                                |
| `CODE`          | `255` (código do país usado no pareamento)               |
| `DEVICE`        | `default` (`android` = botões, `ios` = texto)            |
| `OWNER_NUMBER`  | **seu** número, só dígitos (ex.: `5531999887766`) — define o dono |
| `PAIR_NUMBER`   | opcional; número do pairing code se for diferente do dono |

---

## 3. Parear o WhatsApp

Não existe mais QR na tela: o bot gera um **pairing code**.

1. Abra os logs do serviço no Render (**Logs**).
2. Quando aparecer:

   ```
   [SESSION] store=postgres (Neon) namespace="default" linked=no
   📱 No session found, requesting pairing code... (5531999887766)
   🔐 PAIRING CODE: ABCD-EFGH
   ```

   Confira o número entre parênteses: ele tem que ser o seu, o mesmo que você
   colocou em `OWNER_NUMBER`/`PAIR_NUMBER`. Se aparecer `255752593977`, a
   variável de ambiente não chegou ao processo — revise em
   **Environment** e faça *Manual Deploy → Clear build cache*.

3. No celular: **WhatsApp → ⋮ (ou ⚙) → Aparelhos conectados → Conectar um
   aparelho → Não consegue acessar a câmera?** e digite o código.
4. O log passa a mostrar `🚀 Connected` e, nos próximos restarts,
   `[SESSION] ... linked=yes` — sem pedir código de novo.

Também dá para pedir um código novo pelo comando `!pair 255764182801`
(depois de já estar logado).

---

## 4. Manter o bot acordado (plano free)

No plano **Free** o Render desliga a instância depois de **15 min sem
tráfego HTTP**; o bot fica offline até alguém acessar a URL. Como o Render
só disponibiliza Cron Job em planos pagos, use um monitor externo grátis:

* [UptimeRobot](https://uptimerobot.com) ou [cron-job.org](https://cron-job.org)
* URL: `https://SEU-SERVICO.onrender.com/health`, intervalo **5 a 10 minutos**.

Se você tem plano pago, descomente o bloco `- type: cron` no final do
`render.yaml` (ele usa o `scripts/keepalive.js`) **ou** rode:

```bash
APP_URL=https://SEU-SERVICO.onrender.com npm run keepalive
```

> O Neon também hiberna depois de 5 min sem consultas. Enquanto o bot está
> acordado ele faz um `SELECT 1` a cada 3 minutos, então o banco fica quente.

---

## 5. O que mudou no código para isso funcionar

| Arquivo              | Mudança                                                                 |
| -------------------- | ----------------------------------------------------------------------- |
| `render.yaml`        | Blueprint do Render (build/start/health check/env vars).                 |
| `lib/authState.js`   | **Novo.** Sessão do WhatsApp no Postgres (`whatsapp_auth`) em vez de arquivos, com fallback automático para a pasta `Session/`. |
| `database/config.js` | `node:sqlite` virou import opcional (o app agora sobe em qualquer Node ≥ 20); `DATABASE_URL` com `sslmode=disable` é respeitado; exporta o pool (`pgPool`). |
| `index.js`           | Usa o `useAuthState` novo; detecta "já pareado?" pelo banco em vez de `Session/creds.json`; limpa a sessão do banco no logout; o número de pareamento/dono deixou de ser fixo e agora vem de `OWNER_NUMBER`/`PAIR_NUMBER` (fallback: o número original do autor). |
| `scripts/keepalive.js` | **Novo.** Ping em `/health` para evitar o spin-down do plano free.      |
| `.node-version`      | Node 22.                                                                |

Variáveis extras:

* `SESSION_STORE=auto|postgres|file` — força onde a sessão é guardada.
* `SESSION_NAME=...` — permite vários bots no mesmo banco do Neon.

---

## 6. Como a aplicação funciona (visão geral)

```
        celular (WhatsApp)
                │  WebSocket (protocolo WhatsApp Web)
                ▼
        index.js  ── startFredi() ──► @whiskeysockets/baileys (fork)
                │                          │
                │                          ├── auth  ──► lib/authState.js ──► Neon (whatsapp_auth)
                │                          └── eventos ─► store / handlers ─► plugins (src/*.js)
                │
                ├──► database/config.js ──► Neon (Postgres) | SQLite | whatsasena.json
                └──► app Express ──► GET /  (página) e GET /health
```

**Boot (`node index.js`)**

1. Lê as variáveis de ambiente (`DATABASE_URL`, `OWNER_NUMBER`, `PAIR_NUMBER`,
   `SESSION_STORE`, `SESSION_NAME`, `PORT`…).
2. Sobe o servidor Express na porta do `PORT` (o Render injeta `10000`). Ele
   serve a página `/` e o **health check `/health`** — é esse endpoint que o
   Render monitora e que o keepalive fica pingando.
3. Chama `startFredi()`, que monta o socket do WhatsApp.

**Conexão / sessão (`lib/authState.js`)**

* Com `DATABASE_URL` definido, as credenciais do WhatsApp (`creds` + chaves de
  criptografia) ficam na tabela **`whatsapp_auth` do Neon**, e não na pasta
  `Session/`. Isso é essencial no Render: o disco é efêmero, então a cada
  restart a pasta sumiria e o bot pediria pareamento de novo.
* Sem `DATABASE_URL`, o comportamento é o original: `Session/` em arquivos.
  `SESSION_STORE=file|postgres|auto` força um ou outro.
* No primeiro boot não existe sessão (`linked=no`) → o bot chama
  `requestPairingCode(PAIR_NUMBER)` e imprime `🔐 PAIRING CODE: XXXX-XXXX`.
  Você digita esse código no celular (Aparelhos conectados → *Não consegue
  acessar a câmera?*). Depois disso a sessão fica salva no banco e os próximos
  boots mostram `linked=yes` e conectam sozinhos.
* Se o WhatsApp mandar `loggedOut`, a sessão é apagada do banco e o ciclo de
  pareamento recomeça.

**Reconexão**

Baileys emite `connection.update`. O bot trata cada motivo
(`restartRequired`, `timedOut`, `badSession`, `connectionClosed`…) com
**backoff exponencial** e religa sozinho; `loggedOut` limpa a sessão.

**Banco de dados (`database/config.js`)**

Três backends, escolhidos automaticamente nesta ordem:

1. **PostgreSQL / Neon** quando `DATABASE_URL` existe — usado por settings,
   grupos, sudo, bans, warns, histórico de conversa, mapa LID↔telefone e a
   sessão. As tabelas são criadas no primeiro boot.
2. **SQLite** (`node:sqlite` do Node 22+ ou `better-sqlite3`) para uso local.
3. **JSON** (`whatsasena.json`) se não houver nenhum dos dois.

As queries são escritas uma vez e traduzidas para cada backend (`?` no SQLite,
`$1` no Postgres).

**Mensagens e comandos**

Cada mensagem recebida passa pelo handler de eventos → normalização de JID/LID
→ detecção de prefixo → plugin correspondente em `src/`/plugins. Comandos de
owner dependem de `isDevNumber()`, que compara o remetente com o
`OWNER_NUMBER` — por isso configurar essa variável é importante.

**Manter acordado**

No plano Free do Render a instância dorme após 15 min sem tráfego HTTP. Um
ping em `/health` a cada 5–10 min (UptimeRobot, cron-job.org ou o
`scripts/keepalive.js` num Cron Job pago) mantém tudo de pé.


## 7. Solução de problemas

**Build falha compilando módulos nativos (`sharp`, `canvas`, `better-sqlite3`)**
O `sharp` é dependência obrigatória do fork do Baileys e do
`wa-sticker-formatter`. Se o download do binário pré-compilado falhar,
troque o Runtime para **Docker** com esta `Dockerfile` (ela já instala o
`libvips` e o `ffmpeg`):

```dockerfile
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 make g++ libcairo2-dev libpango1.0-dev libjpeg-dev \
      libgif-dev librsvg2-dev libvips-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN node patch-baileys.js
ENV NODE_ENV=production PORT=10000
EXPOSE 10000
CMD ["node", "index.js"]
```

**Log: `⚠️ [DB] No SQLite backend available and no DATABASE_URL`**
A variável `DATABASE_URL` não chegou ao processo. Confira no Render em
**Environment** (sem espaços antes/depois) e faça um *Manual Deploy → Clear
build cache*.

**Log: `⚠️ [DB] PostgreSQL unavailable (...)`** → cai para JSON/memória.
Quase sempre é a connection string errada (falta `?sslmode=require`, senha
com caractere especial não escapado, ou você usou a string *unpooled* num
projeto que exige pooler).

**Bot pede pairing code em todo restart** → `SESSION_STORE` está `file` ou o
banco não está conectando; o correto é `[SESSION] store=postgres ...
linked=yes` no log.

**`ffmpeg: not found` em algum comando** → o `apt-get` do build não rodou
(sem permissão/indisponível). A maioria dos comandos usa o binário estático
do `@ffmpeg-installer/ffmpeg`; só `!toimg` depende do `ffmpeg` do sistema.

**Quero zerar a sessão e parear de novo**

```sql
DELETE FROM whatsapp_auth;
```

no console do Neon (ou rode com `SESSION_NAME` novo).

---

## 8. Banco local sem Neon (desenvolvimento)

Sem `DATABASE_URL` o bot continua funcionando: SQLite (`node:sqlite` ou
`better-sqlite3`) e, se não houver nenhum dos dois, um JSON
(`whatsasena.json`). Só lembre que aí a sessão volta para a pasta `Session/`.
