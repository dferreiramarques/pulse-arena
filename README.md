# PULSE // LAN

Jogo de ritmo competitivo. Dois ambientes:

- **Local** — 1 ou 2 jogadores no mesmo PC (teclado partilhado ou toque no telemóvel). Não precisa de servidor.
- **LAN** — 2 a 8 jogadores, cada um no seu computador, ligados pela rede local. Precisa do servidor (abaixo).

O cliente é o ficheiro `pulse-arena-mvp.html`. O servidor é `server.js`.

## Correr o servidor LAN

Precisas de [Node.js](https://nodejs.org) (18+).

```bash
# na pasta que tem server.js, package.json e pulse-arena-mvp.html
npm install
npm start
```

O terminal mostra os endereços, por exemplo:

```
PULSE // LAN — servidor a correr
  Local:  http://localhost:3000
  LAN:    http://192.168.1.20:3000   (abre isto nos outros PCs)
```

1. No PC anfitrião, abre `http://localhost:3000`.
2. Nos outros PCs da **mesma rede**, abre `http://IP-DO-ANFITRIAO:3000` (o tal `192.168.x.x:3000`).
3. Em cada um: **Jogar em LAN** → o endereço já vem preenchido → **Ligar**.

> Todos têm de estar na mesma rede local. Se não ligar, é quase sempre a **firewall** do PC anfitrião a bloquear a porta 3000 — autoriza o Node nas redes privadas.

## Como funciona o jogo em LAN

- **Salas**: qualquer jogador cria uma sala (aberta ou com password). As abertas aparecem na lista; clicas em **Entrar**.
- **Lobby**: o anfitrião (👑) escolhe o mapa da sua biblioteca e carrega em **Iniciar**; os outros marcam **Pronto**. São precisos 2+ jogadores.
- **Arranque sincronizado**: o servidor marca um instante de início e cada cliente ajusta o relógio (ping/pong tipo NTP) para todos arrancarem ao mesmo tempo. O **áudio e o mapa são enviados pelo servidor** — cada cliente toca localmente, por isso não há lag de streaming.
- **Leaderboard ao vivo**: durante a partida cada cliente envia a pontuação; o servidor difunde o ranking a todos (painel no topo).
- **Modo campeonato**: igual às salas normais, mas no fim de cada ronda **o pior jogador é eliminado** e não joga a ronda seguinte. Repete até sobrar um — o campeão. (Voltar à sala → o anfitrião inicia a próxima ronda.)

## Arquitetura

```
 navegador (cliente)            servidor Node (ws)
 ─────────────────              ──────────────────
 motor de ritmo  ─ score ───▶   salas + jogadores
 áudio local     ◀─ mapa ────   distribui mapa/áudio
 relógio local   ◀─ startAt ─   arranque sincronizado
 leaderboard     ◀─ ranking ─   recolhe e difunde scores
                                campeonato (eliminação)
```

O servidor serve o próprio cliente (`/`) e fala WebSocket na mesma porta.

### Protocolo (JSON por WebSocket)

Cliente → servidor: `hello`, `listRooms`, `createRoom`, `joinRoom`, `leaveRoom`, `ready`, `setMap`, `start`, `score`, `finished`, `ping`.

Servidor → cliente: `welcome`, `rooms`, `joined`, `roomUpdate`, `error`, `pong`, `matchStart`, `leaderboard`, `matchEnd`.

## Formato de mapa

```json
{ "title": "...", "bpm": 128, "notes": [ {"t": 1.875, "lane": 0} ], "audio": "<base64 opcional>", "audioName": "..." }
```

`t` em segundos, `lane` 0–3. Cria mapas no **Editor**; guarda na app ou exporta para ficheiro (`.json`, com o áudio embutido).

## Notas e limites

- Este é um MVP para testar e iterar; a sincronização foi pensada para a baixa latência da LAN.
- O armazenamento "na app" do cliente é local ao ambiente do browser (não é uma pasta visível). Para persistência controlada por ti, usa **Exportar/Importar ficheiro** no editor.
- O áudio dos mapas viaja embutido nas mensagens; em LAN não há problema, mas mantém os ficheiros razoáveis.
