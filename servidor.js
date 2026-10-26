
// servidor.js
// Servidor da Navalha de Ouro - agendamentos
// Agora os dados ficam num banco PostgreSQL (Neon) em vez dos arquivos JSON.
// Precisa rodar "npm install" uma vez (instala o pacote "pg", que conversa com o banco).

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// Faz o banco devolver preço (tipo numeric) como número, e não como texto
types.setTypeParser(1700, (valor) => parseFloat(valor));

// Conexão com o banco. A DATABASE_URL fica no Environment do Render (e no .env no seu PC)
if (!process.env.DATABASE_URL) {
  console.error('ERRO: DATABASE_URL não configurada. Coloque ela no Environment do Render ou no arquivo .env');
  process.exit(1);
}
const banco = new Pool({ connectionString: process.env.DATABASE_URL });

const PORTA = process.env.PORT || 3000;
const PASTA_DADOS = path.join(__dirname, 'dados');
const ARQ_BARBEIROS = path.join(PASTA_DADOS, 'barbeiros.json');
const ARQ_SERVICOS = path.join(PASTA_DADOS, 'servicos.json');
const ARQ_CONFIGURACAO = path.join(PASTA_DADOS, 'configuracao.json');
const PASTA_PUBLIC = path.join(__dirname, 'public');

// ---------- Configuração de e-mail (opcional) ----------
// Pra ativar o envio de e-mail de verdade, crie uma conta grátis em https://resend.com,
// pegue sua API key e cole abaixo. Enquanto RESEND_API_KEY estiver vazio,
// o sistema só mostra no console o que teria sido enviado (não dá erro, só não manda de verdade).
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_REMETENTE = 'onboarding@resend.dev';

// ---------- Proteção da área de admin ----------
// No Render, configure ADMIN_USUARIO e ADMIN_SENHA em Environment.
// Enquanto não configurar, usa esses valores padrão (troque antes de divulgar o site!).
const ADMIN_USUARIO = process.env.ADMIN_USUARIO || 'admin';
const ADMIN_SENHA = process.env.ADMIN_SENHA || 'troque-essa-senha';

function verificarSenhaAdmin(req) {
  const cabecalho = req.headers['authorization'];
  if (!cabecalho) return false;
  const credenciais = Buffer.from(cabecalho.split(' ')[1], 'base64').toString();
  const [usuario, senha] = credenciais.split(':');
  return usuario === ADMIN_USUARIO && senha === ADMIN_SENHA;
}

function pedirSenhaAdmin(res) {
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Admin Navalha de Ouro"' });
  res.end('Acesso negado');
}

async function enviarEmail(destinatario, assunto, corpo) {
  if (!RESEND_API_KEY) {
    console.log('--- E-mail NÃO enviado (RESEND_API_KEY não configurada) ---');
    console.log(`Para: ${destinatario}`);
    console.log(corpo);
    console.log('-----------------------------------------------------------');
    return;
  }

  try {
    const resposta = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: EMAIL_REMETENTE,
        to: destinatario,
        subject: assunto,
        text: corpo
      })
    });
    if (!resposta.ok) {
      console.error('Falha ao enviar e-mail:', await resposta.text());
    }
  } catch (erro) {
    console.error('Erro ao enviar e-mail:', erro.message);
  }
}

async function enviarEmailConfirmacao(agendamento) {
  const corpo = `
    Agendamento realizado com sucesso!

    Cliente: ${agendamento.cliente}
    Barbeiro: ${agendamento.barbeiro}
    Serviço: ${agendamento.servico}
    Data: ${agendamento.data}
    Horário: ${agendamento.hora}
  `;
  await enviarEmail(agendamento.email, 'Agendamento confirmado - Navalha de Ouro', corpo);
}

// E-mail que recebe aviso de todo agendamento novo (dono/barbearia).
// Configure no Render: EMAIL_AVISO_BARBEARIA.
const EMAIL_AVISO_BARBEARIA = process.env.EMAIL_AVISO_BARBEARIA || '';

async function enviarAvisoBarbearia(agendamento) {
  if (!EMAIL_AVISO_BARBEARIA) return;
  const corpo = `
    Novo agendamento na Navalha de Ouro!

    Cliente: ${agendamento.cliente}
    Telefone: ${agendamento.telefone || 'não informado'}
    Barbeiro: ${agendamento.barbeiro}
    Serviço: ${agendamento.servico}
    Data: ${agendamento.data}
    Horário: ${agendamento.hora}
  `;
  await enviarEmail(EMAIL_AVISO_BARBEARIA, `Novo agendamento: ${agendamento.cliente} - ${agendamento.data} ${agendamento.hora}`, corpo);
}

// ---------- Banco de dados: cria as tabelas na primeira vez ----------
// Na primeira vez que o servidor sobe, ele cria as tabelas e copia
// os barbeiros e serviços dos arquivos JSON pro banco. Depois disso, só usa o banco.
async function prepararBanco() {
  await banco.query(`
    CREATE TABLE IF NOT EXISTS barbeiros (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS servicos (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL UNIQUE,
      duracao INTEGER NOT NULL,
      preco NUMERIC(10,2) NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agendamentos (
      id SERIAL PRIMARY KEY,
      cliente TEXT NOT NULL,
      telefone TEXT DEFAULT '',
      email TEXT DEFAULT '',
      barbeiro TEXT NOT NULL,
      servico TEXT NOT NULL,
      duracao INTEGER NOT NULL,
      preco NUMERIC(10,2) NOT NULL,
      data TEXT NOT NULL,
      hora TEXT NOT NULL,
      criado_em TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Se o banco ainda não tem barbeiros, copia do barbeiros.json
  const { rows: qtdBarbeiros } = await banco.query('SELECT COUNT(*)::int AS total FROM barbeiros');
  if (qtdBarbeiros[0].total === 0 && fs.existsSync(ARQ_BARBEIROS)) {
    for (const nome of lerJSON(ARQ_BARBEIROS)) {
      await banco.query('INSERT INTO barbeiros (nome) VALUES ($1) ON CONFLICT DO NOTHING', [nome]);
    }
    console.log('Barbeiros copiados do JSON pro banco.');
  }

  // Se o banco ainda não tem serviços, copia do servicos.json
  const { rows: qtdServicos } = await banco.query('SELECT COUNT(*)::int AS total FROM servicos');
  if (qtdServicos[0].total === 0 && fs.existsSync(ARQ_SERVICOS)) {
    for (const s of lerJSON(ARQ_SERVICOS)) {
      await banco.query(
        'INSERT INTO servicos (nome, duracao, preco) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [s.nome, s.duracao, s.preco]
      );
    }
    console.log('Serviços copiados do JSON pro banco.');
  }
}

// A configuração (horário de funcionamento) continua no configuracao.json por enquanto,
// porque ela fica no GitHub e não some quando o Render reinicia.
function lerJSON(caminho) {
  return JSON.parse(fs.readFileSync(caminho, 'utf-8'));
}

// ---------- Regra de conflito de horário (mesma lógica de antes) ----------
async function horarioDisponivel(novo) {
  // Pega só os agendamentos daquele barbeiro naquele dia
  const { rows: agendamentos } = await banco.query(
    'SELECT * FROM agendamentos WHERE barbeiro = $1 AND data = $2',
    [novo.barbeiro, novo.data]
  );
  const inicioNovo = new Date(`${novo.data}T${novo.hora}`);
  const fimNovo = new Date(inicioNovo.getTime() + novo.duracao * 60000);

  for (const ag of agendamentos) {
    const inicioAg = new Date(`${ag.data}T${ag.hora}`);
    const fimAg = new Date(inicioAg.getTime() + ag.duracao * 60000);

    if (inicioNovo < fimAg && fimNovo > inicioAg) {
      return false;
    }
  }
  return true;
}

// ---------- Ajuda pra ler o corpo da requisição (POST) ----------
function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let corpo = '';
    req.on('data', (parte) => (corpo += parte));
    req.on('end', () => {
      try {
        resolve(corpo ? JSON.parse(corpo) : {});
      } catch (erro) {
        reject(erro);
      }
    });
  });
}

function responderJSON(res, status, dados) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(dados));
}

// ---------- Servir arquivos estáticos (as páginas HTML/CSS) ----------
const TIPOS_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8'
};

function servirArquivoEstatico(res, caminho) {
  fs.readFile(caminho, (erro, conteudo) => {
    if (erro) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Página não encontrada');
      return;
    }
    const extensao = path.extname(caminho);
    res.writeHead(200, { 'Content-Type': TIPOS_MIME[extensao] || 'text/plain' });
    res.end(conteudo);
  });
}

// ---------- Servidor principal ----------
const servidor = http.createServer(async (req, res) => {
  try {
    await tratarRequisicao(req, res);
  } catch (erro) {
    // Se o banco der algum problema, responde erro em vez de derrubar o servidor
    console.error('Erro na rota', req.method, req.url, '-', erro.message);
    if (!res.headersSent) responderJSON(res, 500, { erro: 'Erro no servidor. Tente de novo.' });
  }
});

async function tratarRequisicao(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const rota = url.pathname;

  // Páginas
  if (req.method === 'GET' && rota === '/') {
    return servirArquivoEstatico(res, path.join(PASTA_PUBLIC, 'cliente.html'));
  }
  if (req.method === 'GET' && rota === '/barbeiro') {
    return servirArquivoEstatico(res, path.join(PASTA_PUBLIC, 'barbeiro.html'));
  }
  if (req.method === 'GET' && rota === '/estilo.css') {
    return servirArquivoEstatico(res, path.join(PASTA_PUBLIC, 'estilo.css'));
  }

  // Página de admin (protegida por senha)
  if (req.method === 'GET' && rota === '/admin') {
    if (!verificarSenhaAdmin(req)) return pedirSenhaAdmin(res);
    return servirArquivoEstatico(res, path.join(PASTA_PUBLIC, 'admin.html'));
  }

  // API: barbeiros e serviços (pra preencher os selects)
  if (req.method === 'GET' && rota === '/api/barbeiros') {
    return responderJSON(res, 200, await listarBarbeiros());
  }
  if (req.method === 'GET' && rota === '/api/servicos') {
    return responderJSON(res, 200, await listarServicos());
  }
  if (req.method === 'GET' && rota === '/api/configuracao') {
    return responderJSON(res, 200, lerJSON(ARQ_CONFIGURACAO));
  }

  // API: cadastrar barbeiro
  if (req.method === 'POST' && rota === '/api/barbeiros') {
    if (!verificarSenhaAdmin(req)) return responderJSON(res, 401, { erro: 'Acesso negado.' });
    try {
      const dados = await lerCorpo(req);
      const nome = (dados.nome || '').trim();
      if (!nome) return responderJSON(res, 400, { erro: 'Informe o nome do barbeiro.' });

      const resultado = await banco.query(
        'INSERT INTO barbeiros (nome) VALUES ($1) ON CONFLICT (nome) DO NOTHING',
        [nome]
      );
      if (resultado.rowCount === 0) {
        return responderJSON(res, 409, { erro: 'Esse barbeiro já está cadastrado.' });
      }
      return responderJSON(res, 201, await listarBarbeiros());
    } catch (erro) {
      return responderJSON(res, 500, { erro: 'Erro ao cadastrar barbeiro.' });
    }
  }

  // API: remover barbeiro
  if (req.method === 'DELETE' && rota.startsWith('/api/barbeiros/')) {
    if (!verificarSenhaAdmin(req)) return responderJSON(res, 401, { erro: 'Acesso negado.' });
    const nome = decodeURIComponent(rota.split('/').pop());
    await banco.query('DELETE FROM barbeiros WHERE nome = $1', [nome]);
    return responderJSON(res, 200, await listarBarbeiros());
  }

  // API: cadastrar serviço
  if (req.method === 'POST' && rota === '/api/servicos') {
    if (!verificarSenhaAdmin(req)) return responderJSON(res, 401, { erro: 'Acesso negado.' });
    try {
      const dados = await lerCorpo(req);
      const nome = (dados.nome || '').trim();
      const duracao = Number(dados.duracao);
      const preco = Number(dados.preco);

      if (!nome || !duracao || duracao <= 0 || isNaN(preco) || preco < 0) {
        return responderJSON(res, 400, { erro: 'Preencha nome, duração (min) e preço corretamente.' });
      }

      const resultado = await banco.query(
        'INSERT INTO servicos (nome, duracao, preco) VALUES ($1, $2, $3) ON CONFLICT (nome) DO NOTHING',
        [nome, duracao, preco]
      );
      if (resultado.rowCount === 0) {
        return responderJSON(res, 409, { erro: 'Já existe um serviço com esse nome.' });
      }
      return responderJSON(res, 201, await listarServicos());
    } catch (erro) {
      return responderJSON(res, 500, { erro: 'Erro ao cadastrar serviço.' });
    }
  }

  // API: remover serviço
  if (req.method === 'DELETE' && rota.startsWith('/api/servicos/')) {
    if (!verificarSenhaAdmin(req)) return responderJSON(res, 401, { erro: 'Acesso negado.' });
    const nome = decodeURIComponent(rota.split('/').pop());
    await banco.query('DELETE FROM servicos WHERE nome = $1', [nome]);
    return responderJSON(res, 200, await listarServicos());
  }

  // API: listar agendamentos (com filtro opcional por barbeiro e data)
  if (req.method === 'GET' && rota === '/api/agendamentos') {
    const barbeiroF = url.searchParams.get('barbeiro');
    const dataF = url.searchParams.get('data');

    // Monta o filtro só com o que veio na URL
    const condicoes = [];
    const valores = [];
    if (barbeiroF) {
      valores.push(barbeiroF);
      condicoes.push(`barbeiro = $${valores.length}`);
    }
    if (dataF) {
      valores.push(dataF);
      condicoes.push(`data = $${valores.length}`);
    }
    const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

    const { rows } = await banco.query(
      `SELECT id, cliente, telefone, email, barbeiro, servico, duracao, preco, data, hora
       FROM agendamentos ${where} ORDER BY data, hora`,
      valores
    );
    return responderJSON(res, 200, rows);
  }

  // API: criar agendamento
  if (req.method === 'POST' && rota === '/api/agendamentos') {
    try {
      const dados = await lerCorpo(req);
      const { rows: achados } = await banco.query('SELECT * FROM servicos WHERE nome = $1', [dados.servico]);
      const servico = achados[0];

      if (!dados.cliente || !dados.barbeiro || !servico || !dados.data || !dados.hora) {
        return responderJSON(res, 400, { erro: 'Preencha todos os campos obrigatórios.' });
      }

      const novoAgendamento = {
        cliente: dados.cliente,
        telefone: dados.telefone || '',
        email: dados.email || '',
        barbeiro: dados.barbeiro,
        servico: servico.nome,
        duracao: servico.duracao,
        preco: servico.preco,
        data: dados.data,
        hora: dados.hora
      };

      if (!(await horarioDisponivel(novoAgendamento))) {
        return responderJSON(res, 409, { erro: `${dados.barbeiro} já tem um horário marcado nesse período.` });
      }

      const { rows: inseridos } = await banco.query(
        `INSERT INTO agendamentos (cliente, telefone, email, barbeiro, servico, duracao, preco, data, hora)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          novoAgendamento.cliente, novoAgendamento.telefone, novoAgendamento.email,
          novoAgendamento.barbeiro, novoAgendamento.servico, novoAgendamento.duracao,
          novoAgendamento.preco, novoAgendamento.data, novoAgendamento.hora
        ]
      );
      novoAgendamento.id = inseridos[0].id;

      if (novoAgendamento.email) {
        enviarEmailConfirmacao(novoAgendamento); // não precisa esperar terminar pra responder
      }
      enviarAvisoBarbearia(novoAgendamento); // avisa a barbearia de todo agendamento novo

      return responderJSON(res, 201, novoAgendamento);
    } catch (erro) {
      return responderJSON(res, 500, { erro: 'Erro ao processar o agendamento.' });
    }
  }

  // API: cancelar agendamento
  if (req.method === 'DELETE' && rota.startsWith('/api/agendamentos/')) {
    const id = Number(rota.split('/').pop());
    await banco.query('DELETE FROM agendamentos WHERE id = $1', [id]);
    return responderJSON(res, 200, { ok: true });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Rota não encontrada');
}

// ---------- Funções que buscam listas no banco ----------
// Barbeiros voltam como lista de nomes (igual era no JSON), pras páginas não precisarem mudar
async function listarBarbeiros() {
  const { rows } = await banco.query('SELECT nome FROM barbeiros ORDER BY id');
  return rows.map((b) => b.nome);
}

async function listarServicos() {
  const { rows } = await banco.query('SELECT nome, duracao, preco FROM servicos ORDER BY id');
  return rows;
}

// ---------- Liga o servidor (só depois que o banco estiver pronto) ----------
prepararBanco()
  .then(() => {
    servidor.listen(PORTA, () => {
      console.log('Banco de dados conectado!');
      console.log(`Servidor da Navalha de Ouro rodando em http://localhost:${PORTA}`);
      console.log(`Página do cliente: http://localhost:${PORTA}/`);
      console.log(`Página do barbeiro: http://localhost:${PORTA}/barbeiro`);
    });
  })
  .catch((erro) => {
    console.error('Não consegui conectar no banco:', erro.message);
    process.exit(1);
  });
