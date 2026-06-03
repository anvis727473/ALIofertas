// ═══════════════════════════════════════════════════════════
//  ALIEXPRESS DEAL BOT — Arquivo centralizado
// ═══════════════════════════════════════════════════════════

import crypto from 'node:crypto';
import express from 'express';
import { Bot } from 'grammy';
import { createClient } from '@supabase/supabase-js';

// ┌────────────────────────────────────────────────────────┐
// │  VALIDAÇÃO — NÃO MATA O PROCESSO                      │
// └────────────────────────────────────────────────────────┘

function checkEnv() {
  const required = [
    'TELEGRAM_BOT_TOKEN',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'ALIEXPRESS_APP_KEY',
    'ALIEXPRESS_APP_SECRET',
    'ALIEXPRESS_TRACKING_ID',
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error('❌ Faltando variáveis:', missing.join(', '));
    console.error('→ Adicione em Settings > Environment Variables no Render');
    return false;
  }
  console.log('✅ Todas as variáveis OK');
  return true;
}

const envOk = checkEnv();
const PORT = process.env.PORT || 10000;

// ┌────────────────────────────────────────────────────────┐
// │  SERVIDOR EXPRESS — SOBE PRIMEIRO                      │
// └────────────────────────────────────────────────────────┘

const app = express();
app.use(express.json());

app.get('/', (_req, res) => {
  res.json({
    status: envOk ? 'ok' : 'missing_env_vars',
    bot: 'AliExpress Deal Bot',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (_req, res) => res.sendStatus(200));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);

  if (envOk) {
    startBot();
  } else {
    console.error('⚠️  Bot NÃO iniciado — corrija as variáveis de ambiente');
  }
});

// ┌────────────────────────────────────────────────────────┐
// │  BOT + SUPABASE + ALIEXPRESS — só inicia se env OK     │
// └────────────────────────────────────────────────────────┘

async function startBot() {
  try {
    // ── Supabase ──────────────────────────────────────────
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    console.log('✅ Supabase conectado');

    // ── Funções de banco ──────────────────────────────────
    async function upsertUser(chatId, username, firstName) {
      const { error } = await supabase
        .from('bot_users')
        .upsert(
          { chat_id: chatId, username, first_name: firstName },
          { onConflict: 'chat_id' }
        );
      if (error) console.error('upsertUser:', error.message);
    }

    async function updateLastSearch(chatId, query) {
      const { error } = await supabase
        .from('bot_users')
        .update({ last_searched: query })
        .eq('chat_id', chatId);
      if (error) console.error('updateLastSearch:', error.message);
    }

    async function saveDeal(deal) {
      const { data, error } = await supabase
        .from('deals')
        .insert(deal)
        .select()
        .single();
      if (error) console.error('saveDeal:', error.message);
      return data;
    }

    async function getRecentDeals(limit = 10) {
      const { data, error } = await supabase
        .from('deals')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) console.error('getRecentDeals:', error.message);
      return data ?? [];
    }

    // ── AliExpress API ───────────────────────────────────
    function aliSign(params, appSecret) {
      const sorted = Object.keys(params).sort();
      let base = appSecret;
      for (const key of sorted) base += key + params[key];
      base += appSecret;
      return crypto.createHash('md5').update(base, 'utf8').digest('hex').toUpperCase();
    }

    async function aliApi(method, params = {}) {
      const allParams = {
        app_key: process.env.ALIEXPRESS_APP_KEY,
        method,
        timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
        v: '2.0',
        sign_method: 'md5',
        format: 'json',
        ...params,
      };
      allParams.sign = aliSign(allParams, process.env.ALIEXPRESS_APP_SECRET);

      const qs = new URLSearchParams(allParams).toString();
      const res = await fetch('https://api-sg.aliexpress.com/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: qs,
      });

      if (!res.ok) throw new Error(`AliExpress ${res.status}: ${await res.text()}`);
      return res.json();
    }

    async function searchProducts(keyword, page = 1, size = 10) {
      const result = await aliApi('aliexpress.affiliate.product.query', {
        keywords: keyword,
        target_currency: 'USD',
        target_language: 'EN',
        tracking_id: process.env.ALIEXPRESS_TRACKING_ID,
        page_no: String(page),
        page_size: String(size),
        sort: 'SALE_PRICE_ASC',
      });

      const products =
        result?.aliexpress_affiliate_product_query_response
          ?.resp_result?.result?.products?.product ?? [];

      return products.map((p) => ({
        id: String(p.product_id ?? ''),
        title: p.product_title ?? 'Sem título',
        image: p.product_main_image_url ?? '',
        url: p.product_detail_url ?? '',
        price: parseFloat(p.target_sale_price ?? p.sale_price ?? '0'),
        currency: p.target_sale_price_currency ?? 'USD',
        rating: parseFloat(p.evaluate_rate ?? '0') / 20,
        orders: parseInt(p.promotion?.orders ?? '0', 10),
        discount: p.discount ?? '',
        shop: p.shop_name ?? '',
      }));
    }

    async function generateAffLink(productUrl) {
      const result = await aliApi('aliexpress.affiliate.link.generate', {
        promotion_link_type: '0',
        source_values: productUrl,
        tracking_id: process.env.ALIEXPRESS_TRACKING_ID,
      });

      const links =
        result?.aliexpress_affiliate_link_generate_response
          ?.resp_result?.result?.promotion_links?.promotion_link ?? [];

      return links[0]?.promotion_link ?? productUrl;
    }

    // ── Formatação ───────────────────────────────────────
    function esc(text) {
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function dealMsg(product, affLink) {
      const s = product.rating > 0 ? '⭐'.repeat(Math.round(product.rating)) : '—';
      return [
        `🔥 <b>${esc(product.title)}</b>`,
        ``,
        `💰 Preço: <b>${product.currency} ${product.price.toFixed(2)}</b>`,
        product.discount ? `🏷️ Desconto: <b>${product.discount}</b>` : null,
        `📊 Avaliação: ${s} (${product.rating.toFixed(1)}/5)`,
        product.orders > 0 ? `🛒 ${product.orders.toLocaleString()} pedidos` : null,
        product.shop ? `🏪 Loja: ${product.shop}` : null,
        ``,
        `🔗 <a href="${affLink}">COMPRAR NO ALIEXPRESS</a>`,
      ].filter(Boolean).join('\n');
    }

    // ── Bot Telegram ─────────────────────────────────────
    const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
    console.log('✅ Bot criado');

    bot.command('start', async (ctx) => {
      await upsertUser(ctx.chat.id, ctx.from.username, ctx.from.first_name);
      await ctx.reply(
        `👋 Olá, ${ctx.from.first_name}!\n\n` +
        `Sou seu bot de ofertas do AliExpress.\n\n` +
        `📌 <b>Como usar:</b>\n` +
        `• <code>/buscar fone bluetooth</code>\n` +
        `• Ou envie o nome do produto\n\n` +
        `📌 <b>Comandos:</b>\n` +
        `• /buscar &lt;produto&gt;\n` +
        `• /ofertas\n` +
        `• /postar &lt;url&gt;\n` +
        `• /ajuda`,
        { parse_mode: 'HTML' }
      );
    });

    bot.command('ajuda', async (ctx) => {
      await ctx.reply(
        `📖 <b>Comandos:</b>\n\n` +
        `<code>/buscar mouse wireless</code>\n→ Busca e gera links\n\n` +
        `<code>/ofertas</code>\n→ Últimas 10 ofertas\n\n` +
        `<code>/postar https://aliexpress.com/item/...</code>\n→ Link de afiliado\n\n` +
        `Ou digite o nome de qualquer produto!`,
        { parse_mode: 'HTML' }
      );
    });

    bot.command('buscar', async (ctx) => {
      const keyword = ctx.match?.trim();
      if (!keyword) return ctx.reply('⚠️ Use: /buscar <produto>');
      await doSearch(ctx, keyword);
    });

    bot.command('ofertas', async (ctx) => {
      const deals = await getRecentDeals(10);
      if (!deals.length) return ctx.reply('📭 Nenhuma oferta ainda.');
      let msg = '📋 <b>Ofertas recentes:</b>\n\n';
      for (const d of deals.slice(0, 5)) {
        msg += `• <b>${esc(d.title.slice(0, 60))}</b>\n  💰 ${d.currency} ${d.price}  🔗 <a href="${d.affiliate_link}">Comprar</a>\n\n`;
      }
      await ctx.reply(msg, { parse_mode: 'HTML', disable_web_page_preview: true });
    });

    bot.command('postar', async (ctx) => {
      const url = ctx.match?.trim();
      if (!url || !url.startsWith('http')) return ctx.reply('⚠️ Use: /postar <url>');
      try {
        const affLink = await generateAffLink(url);
        await ctx.reply(`🔗 <b>Seu link:</b>\n\n<a href="${affLink}">${affLink}</a>`, { parse_mode: 'HTML' });
      } catch (err) {
        console.error('postar:', err.message);
        await ctx.reply('❌ Erro ao gerar link.');
      }
    });

    bot.on('message:text', async (ctx) => {
      const text = ctx.message.text.trim();
      if (text.startsWith('/') || text.length < 2) return;
      await doSearch(ctx, text);
    });

    async function doSearch(ctx, keyword) {
      await upsertUser(ctx.chat.id, ctx.from.username, ctx.from.first_name);
      await updateLastSearch(ctx.chat.id, keyword);

      const msg = await ctx.reply(`🔍 Buscando "<b>${esc(keyword)}</b>"...`, { parse_mode: 'HTML' });

      try {
        const products = await searchProducts(keyword, 1, 10);
        if (!products.length) {
          return ctx.api.editMessageText(msg.chat.id, msg.message_id,
            `😕 Nenhum resultado para "<b>${esc(keyword)}</b>".`, { parse_mode: 'HTML' });
        }

        await ctx.api.editMessageText(msg.chat.id, msg.message_id,
          `✅ <b>${products.length}</b> encontrados! Enviando...`, { parse_mode: 'HTML' });

        for (const product of products.slice(0, 3)) {
          try {
            const affLink = await generateAffLink(product.url);
            const text = dealMsg(product, affLink);

            if (product.image) {
              await ctx.replyWithPhoto(product.image, { caption: text, parse_mode: 'HTML' });
            } else {
              await ctx.reply(text, { parse_mode: 'HTML' });
            }

            await saveDeal({
              product_id: product.id,
              title: product.title,
              price: product.price,
              currency: product.currency,
              image_url: product.image,
              product_url: product.url,
              affiliate_link: affLink,
              rating: product.rating,
              orders: product.orders,
              posted_to: ctx.chat.id,
            });
          } catch (err) {
            console.error(`Produto ${product.id}:`, err.message);
          }
        }
      } catch (err) {
        console.error('doSearch:', err.message);
        try {
          await ctx.api.editMessageText(msg.chat.id, msg.message_id, '❌ Erro na busca.');
        } catch (_) {}
      }
    }

    bot.catch((err) => console.error('bot.catch:', err.message));

    // ── Webhook ──────────────────────────────────────────
    const secret = process.env.WEBHOOK_SECRET || 'default';
    const webhookPath = `/webhook/${secret}`;

    app.post(webhookPath, async (req, res) => {
      try { await bot.handleUpdate(req.body); }
      catch (err) { console.error('webhook:', err.message); }
      res.sendStatus(200);
    });

    console.log('✅ Rota do webhook registrada:', webhookPath);

    // ── Configurar webhook no Telegram ───────────────────
    const mode = process.env.TELEGRAM_MODE || 'webhook';
    console.log(`📡 Modo: ${mode}`);

    if (mode === 'webhook') {
      const base = process.env.RENDER_EXTERNAL_URL;
      if (!base) {
        console.error('❌ RENDER_EXTERNAL_URL não definido — webhook não configurado');
        console.error('→ Adicione: https://seu-app.onrender.com');
        return;
      }

      const url = `${base}/webhook/${secret}`;
      await bot.api.deleteWebhook({ drop_pending_updates: true });
      await bot.api.setWebhook(url, {
        secret_token: secret,
        allowed_updates: ['message', 'edited_message', 'callback_query'],
      });

      const me = await bot.api.getMe();
      console.log(`✅ Webhook ativo: ${url}`);
      console.log(`🤖 Bot: @${me.username} (${me.first_name})`);
    } else {
      bot.start({
        onStart: (info) => console.log(`🤖 @${info.username} (polling)`),
        drop_pending_updates: true,
      });
    }

  } catch (err) {
    console.error('❌ ERRO FATAL ao iniciar bot:', err.message);
    console.error(err.stack);
    // Servidor Express continua rodando — não mata o processo
  }
}
