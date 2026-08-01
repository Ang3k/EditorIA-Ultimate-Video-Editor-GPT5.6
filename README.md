# EditorIA

Editor local que transforma uma narração em um rascunho de vídeo com B-roll contextual pesquisado no YouTube.

## Stack do MVP

- Next.js + React + TypeScript para a interface local.
- Gemini API com saída JSON estruturada para transcrever a narração, separar unidades visuais e criar o plano de edição.
- YouTube Data API v3 para descoberta de vídeos.
- `yt-dlp` para baixar candidatos públicos selecionados.
- FFmpeg/FFprobe para cortes, normalização, preview e exportação.

## Requisitos locais

- Node.js 20+ (o ambiente atual usa Node 24).
- FFmpeg e FFprobe no PATH.
- Python Launcher (`py`) com `yt-dlp` instalado.
- Chaves em `.env.local` — nunca no Git.

## Rodar

```powershell
npm install
npm run dev
```

Abra `http://localhost:3000`.

O arquivo `.env.local` deve conter `GEMINI_API_KEY` e `YOUTUBE_API_KEY`. Não cole essas chaves no chat nem faça commit delas.

## Fluxo atual

1. O usuário envia uma faixa de áudio e um contexto opcional.
2. O servidor cria um job persistido em `work/jobs/<id>`.
3. A narração é transcrita e dividida em unidades visuais.
4. O sistema pesquisa candidatos no YouTube e gera um `edit-plan.json` estruturado.
5. O melhor candidato de cada unidade é baixado, cortado e montado em um preview.
6. O usuário revisa o preview e aprova a exportação final.

O uso e a publicação dos trechos baixados devem respeitar direitos autorais, termos do YouTube e permissões dos respectivos criadores.
