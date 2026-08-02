# EditorIA

Editor local que transforma uma narração em um rascunho de vídeo com gameplay-base contínua e overlays contextuais pesquisados no YouTube.

## Stack

- Next.js + React + TypeScript para a interface local.
- Codex CLI com `gpt-5.6-luna` em raciocínio `max` para perguntas criativas, plano visual, ranking e validação dos clipes.
- faster-whisper local para converter a narração em texto com timestamps.
- `yt-dlp` para pesquisar e baixar fontes públicas do YouTube.
- FFmpeg/FFprobe para normalização, contact sheets, validação de frames, preview e exportação.

## Requisitos locais

- Node.js 20+.
- Codex CLI instalado e autenticado na mesma conta do ambiente que executa o Next.js.
- FFmpeg e FFprobe no PATH.
- Python Launcher (`py`) com `yt-dlp` e faster-whisper instalados.
- Nenhuma chave Gemini, Ollama ou OpenAI API é necessária para o fluxo ativo.

## Rodar

```powershell
npm install
npm run dev
```

Abra `http://localhost:3000`.

## Configuração do Codex

O pipeline executa chamadas isoladas do Codex CLI com:

```text
gpt-5.6-luna · reasoning max · sandbox read-only · output schema JSON
```

O executável padrão no Windows é `codex.cmd` (e `codex` nos demais sistemas). Para informar outro caminho, use `CODEX_CLI_BIN`. A sessão autenticada do Codex é herdada pelo processo do servidor; o aplicativo não envia uma API key diretamente.

## Fluxo

1. O usuário envia a narração e um contexto opcional.
2. O Whisper local gera a transcrição com timestamps.
3. O Luna Max cria perguntas estruturadas para a direção criativa.
4. Depois das respostas, o Luna Max cria unidades visuais e uma consulta para a gameplay-base.
5. O sistema pesquisa candidatos com `yt-dlp`, filtra vídeos editados e envia frames dos candidatos ao Luna para verificação.
6. Uma gameplay-base real é baixada, normalizada e colocada em `V1` cobrindo toda a narração.
7. Overlays aprovados entram em `V2`; quando um overlay é rejeitado, a gameplay-base continua visível.
8. O preview e o final são renderizados pela composição de camadas do editor.

O job falha antes do preview se não conseguir baixar e validar uma gameplay-base real. Isso evita entregar uma timeline preta, incompleta ou preenchida por vídeos sem relação.

O uso e a publicação dos trechos baixados devem respeitar direitos autorais, termos do YouTube e permissões dos respectivos criadores.
