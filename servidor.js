
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

// ---------- Login da recepção (página /barbeiro, vê a agenda de todos) ----------
// No Render, configure BARBEIRO_USUARIO e BARBEIRO_SENHA em Environment.
// Cada barbeiro também tem login próprio (nome + senha), guardado no banco.
const BARBEIRO_USUARIO = process.env.BARBEIRO_USUARIO || '';
const BARBEIRO_SENHA = process.env.BARBEIRO_SENHA || '';

// ---------- Senhas dos barbeiros: guardadas "embaralhadas" (hash) ----------
// O banco nunca guarda a senha de verdade, só um código que não dá pra desfazer.
// Pra conferir, embaralha a senha digitada do mesmo jeito e compara.
const crypto = require('crypto');

function gerarHashSenha(senha) {
  const sal = crypto.randomBytes(16).toString('hex'); // "tempero" aleatório, diferente pra cada senha
  const hash = crypto.scryptSync(senha, sal, 64).toString('hex');
  return `${sal}:${hash}`;
}

function senhaConfere(senha, guardado) {
  if (!guardado) return false;
  const [sal, hash] = guardado.split(':');
  const testado = crypto.scryptSync(senha, sal, 64);
  const original = Buffer.from(hash, 'hex');
  return original.length === testado.length && crypto.timingSafeEqual(original, testado);
}

// Regra de senha: 6 a 50 caracteres, sem espaço e sem acento
// (acento dá problema na janelinha de login de alguns navegadores)
function senhaValida(senha) {
  return typeof senha === 'string' && /^[\x21-\x7E]{6,50}$/.test(senha);
}

// "João Silva" -> "joao silva": assim o barbeiro pode digitar com ou sem acento/maiúscula
function normalizarNome(nome) {
  return String(nome || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

// Guarda por 5 minutos quem já fez login certo, pra não precisar
// embaralhar a senha de novo a cada 10 segundos (a agenda atualiza sozinha)
const loginsConferidos = new Map();
function esquecerLogins() {
  loginsConferidos.clear(); // chamado sempre que alguma senha muda
}

// Descobre QUEM está fazendo o pedido:
//   { tipo: 'admin' }                    -> dono (tudo)
//   { tipo: 'recepcao' }                 -> login compartilhado (agenda de todos)
//   { tipo: 'barbeiro', nome: 'Carlos' } -> só a agenda dele
//   null                                 -> ninguém logado (cliente comum)
async function identificar(req) {
  const login = lerLogin(req);
  if (!login) return null;

  if (login.usuario === ADMIN_USUARIO && login.senha === ADMIN_SENHA) return { tipo: 'admin' };
  if (BARBEIRO_USUARIO && BARBEIRO_SENHA && login.usuario === BARBEIRO_USUARIO && login.senha === BARBEIRO_SENHA) {
    return { tipo: 'recepcao' };
  }

  const chave = req.headers['authorization'];
  const lembrado = loginsConferidos.get(chave);
  if (lembrado && Date.now() < lembrado.expira) return lembrado.quem;

  const { rows } = await banco.query('SELECT nome, senha_hash FROM barbeiros WHERE senha_hash IS NOT NULL');
  const barbeiro = rows.find((b) => normalizarNome(b.nome) === normalizarNome(login.usuario));
  if (!barbeiro || !senhaConfere(login.senha, barbeiro.senha_hash)) return null;

  const quem = { tipo: 'barbeiro', nome: barbeiro.nome };
  loginsConferidos.set(chave, { quem, expira: Date.now() + 5 * 60000 });
  return quem;
}

// Lê o usuário e a senha que o navegador mandou (login da janelinha)
function lerLogin(req) {
  const cabecalho = req.headers['authorization'] || '';
  const [tipo, codigo] = cabecalho.split(' ');
  if (tipo !== 'Basic' || !codigo) return null;
  const texto = Buffer.from(codigo, 'base64').toString();
  const posicao = texto.indexOf(':');
  if (posicao === -1) return null;
  return { usuario: texto.slice(0, posicao), senha: texto.slice(posicao + 1) };
}

// Essas duas usam o "req.quem", que é preenchido uma vez no começo de cada pedido
function verificarSenhaAdmin(req) {
  return req.quem?.tipo === 'admin';
}

// Entra no /barbeiro: admin, recepção ou qualquer barbeiro com senha
function verificarSenhaBarbeiro(req) {
  return !!req.quem;
}

function pedirSenha(res, nome) {
  res.writeHead(401, {
    'WWW-Authenticate': `Basic realm="${nome}", charset="UTF-8"`,
    'Content-Type': 'text/plain; charset=utf-8'
  });
  res.end('Acesso negado');
}

function pedirSenhaAdmin(res) {
  pedirSenha(res, 'Admin Navalha de Ouro');
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

  // Coluna nova: status do agendamento ('agendado', 'atendido' ou 'cancelado').
  // Em vez de apagar, agora a gente só muda o status - assim fica o histórico.
  await banco.query(`ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'agendado'`);

  // Coluna nova: senha de cada barbeiro (embaralhada). Vazia = barbeiro sem acesso ao /barbeiro.
  await banco.query(`ALTER TABLE barbeiros ADD COLUMN IF NOT EXISTS senha_hash TEXT`);

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

// ---------- Data e hora "de agora" no horário de Brasília ----------
// O servidor do Render roda em outro fuso, então a gente calcula na mão.
const FUSO = 'America/Sao_Paulo';

function agoraNoBrasil() {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date());
  const p = Object.fromEntries(partes.map((x) => [x.type, x.value]));
  return { data: `${p.year}-${p.month}-${p.day}`, minutos: Number(p.hour) * 60 + Number(p.minute) };
}

function horaParaMinutos(hora) {
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
}

// Quantos dias faltam de "hoje" até a data (ex: amanhã = 1)
function diasAte(dataHoje, data) {
  return Math.round((Date.parse(`${data}T00:00:00Z`) - Date.parse(`${dataHoje}T00:00:00Z`)) / 86400000);
}

// ---------- Validação do agendamento ----------
// O servidor NÃO confia no que a página manda: confere tudo de novo aqui.
// Devolve a mensagem de erro, ou null se estiver tudo certo.
async function validarAgendamento(dados) {
  const texto = (valor) => (typeof valor === 'string' ? valor.trim() : '');
  const cliente = texto(dados.cliente);
  const telefone = texto(dados.telefone);
  const email = texto(dados.email);
  const data = texto(dados.data);
  const hora = texto(dados.hora);

  if (!cliente || !dados.barbeiro || !dados.servico || !data || !hora) {
    return 'Preencha todos os campos obrigatórios.';
  }
  if (cliente.length < 2 || cliente.length > 60) return 'O nome precisa ter entre 2 e 60 letras.';
  if (telefone && !/^[0-9()+\-\s]{8,20}$/.test(telefone)) return 'Telefone inválido.';
  if (email && (email.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return 'E-mail inválido.';

  // Data e hora no formato certo (2026-11-05 e 14:30) e que existam de verdade
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || isNaN(Date.parse(`${data}T00:00:00Z`)) ||
      new Date(`${data}T00:00:00Z`).toISOString().slice(0, 10) !== data) {
    return 'Data inválida.';
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) return 'Horário inválido.';

  // Barbeiro e serviço precisam existir no banco
  const { rows: barbeiros } = await banco.query('SELECT 1 FROM barbeiros WHERE nome = $1', [dados.barbeiro]);
  if (!barbeiros.length) return 'Barbeiro não encontrado.';
  const { rows: servicos } = await banco.query('SELECT * FROM servicos WHERE nome = $1', [dados.servico]);
  if (!servicos.length) return 'Serviço não encontrado.';
  const servico = servicos[0];

  // Regras da agenda (as mesmas do calendário da página do cliente)
  const config = lerJSON(ARQ_CONFIGURACAO);
  const abertura = horaParaMinutos(config.horarioAbertura || '09:00');
  const fechamento = horaParaMinutos(config.horarioFechamento || '19:30');
  const intervalo = config.intervaloMinutos || 30;
  const antecedenciaMaxima = config.diasAntecedenciaMaxima || 60;
  const inicio = horaParaMinutos(hora);
  const agora = agoraNoBrasil();
  const dias = diasAte(agora.data, data);
  const diaDaSemana = new Date(`${data}T12:00:00Z`).getUTCDay(); // 0 = domingo

  if (dias < 0 || (dias === 0 && inicio <= agora.minutos)) return 'Esse horário já passou.';
  if (dias > antecedenciaMaxima) return `Só dá pra agendar com até ${antecedenciaMaxima} dias de antecedência.`;
  if ((config.diasFechados || []).includes(diaDaSemana)) return 'A barbearia não abre nesse dia.';
  if (inicio < abertura || inicio + servico.duracao > fechamento || (inicio - abertura) % intervalo !== 0) {
    return 'Horário fora do funcionamento da barbearia.';
  }

  return null;
}

// ---------- Proteção contra abuso (muitas tentativas do mesmo lugar) ----------
// Guarda na memória quantas vezes cada IP fez algo, numa janela de tempo.
const tentativas = new Map();

function pegarIP(req) {
  // No Render, o IP verdadeiro vem nesse cabeçalho
  const encaminhado = req.headers['x-forwarded-for'];
  return (encaminhado ? encaminhado.split(',')[0] : req.socket.remoteAddress || '').trim();
}

// Devolve true se esse IP já passou do limite
function passouDoLimite(tipo, req, limite) {
  const chave = `${tipo}:${pegarIP(req)}`;
  const agora = Date.now();
  const registro = tentativas.get(chave);
  if (!registro || agora > registro.expira) return false;
  return registro.quantidade >= limite;
}

function contarTentativa(tipo, req, minutos) {
  const chave = `${tipo}:${pegarIP(req)}`;
  const agora = Date.now();
  const registro = tentativas.get(chave);
  if (!registro || agora > registro.expira) {
    tentativas.set(chave, { quantidade: 1, expira: agora + minutos * 60000 });
  } else {
    registro.quantidade++;
  }
}

// Limpa os registros vencidos a cada 10 minutos, pra memória não encher
setInterval(() => {
  const agora = Date.now();
  for (const [chave, registro] of tentativas) if (agora > registro.expira) tentativas.delete(chave);
}, 10 * 60000).unref();

// ---------- Regra de conflito de horário (mesma lógica de antes) ----------
// "conexao" permite usar dentro de uma transação (ver criação do agendamento)
async function horarioDisponivel(novo, conexao = banco) {
  // Pega só os agendamentos daquele barbeiro naquele dia (cancelados liberam o horário)
  const { rows: agendamentos } = await conexao.query(
    `SELECT * FROM agendamentos WHERE barbeiro = $1 AND data = $2 AND status <> 'cancelado'`,
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
    req.on('data', (parte) => {
      corpo += parte;
      // Ninguém precisa mandar mais que 10 KB pra agendar - corta quem tentar mandar lixo gigante
      if (corpo.length > 10000) {
        req.destroy();
        reject(new Error('Corpo da requisição grande demais'));
      }
    });
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
  // no-store: o navegador não guarda cópia dos dados (tem nome e telefone de cliente)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
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

  // Cabeçalhos de segurança em todas as respostas:
  // - nosniff: o navegador não "adivinha" o tipo do arquivo
  // - DENY: ninguém consegue colocar o site dentro de outro site (golpe do clique escondido)
  // - same-origin: não vaza o endereço das páginas pra sites de fora
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');

  // Proteção contra quem fica chutando senha: 10 erros em 15 minutos bloqueia aquele IP por 15 minutos
  if (req.headers['authorization']) {
    if (passouDoLimite('login', req, 10)) {
      if (rota.startsWith('/api/')) {
        return responderJSON(res, 429, { erro: 'Muitas tentativas de senha. Espere 15 minutos.' });
      }
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Muitas tentativas de senha erradas. Espere 15 minutos e tente de novo.');
    }
    req.quem = await identificar(req); // descobre quem é (admin, recepção ou qual barbeiro)
    if (!req.quem) {
      contarTentativa('login', req, 15);
    }
  }

  // Páginas
  if (req.method === 'GET' && rota === '/') {
    return servirArquivoEstatico(res, path.join(PASTA_PUBLIC, 'cliente.html'));
  }
  // Página do barbeiro (protegida por senha)
  if (req.method === 'GET' && rota === '/barbeiro') {
    if (!verificarSenhaBarbeiro(req)) return pedirSenha(res, 'Agenda Navalha de Ouro');
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
      const senha = dados.senha || '';
      if (!nome) return responderJSON(res, 400, { erro: 'Informe o nome do barbeiro.' });
      if (nome.length > 40) return responderJSON(res, 400, { erro: 'Nome muito grande (máximo 40 letras).' });
      if (nome.includes(':')) return responderJSON(res, 400, { erro: 'O nome não pode ter dois pontos (:).' });
      if (senha && !senhaValida(senha)) {
        return responderJSON(res, 400, { erro: 'Senha precisa ter de 6 a 50 caracteres, sem espaço e sem acento.' });
      }

      // Como o nome vira login, não pode ter dois iguais (nem "João" e "Joao")
      const existentes = await listarBarbeiros();
      if (existentes.some((b) => normalizarNome(b) === normalizarNome(nome))) {
        return responderJSON(res, 409, { erro: 'Já existe um barbeiro com esse nome.' });
      }

      await banco.query('INSERT INTO barbeiros (nome, senha_hash) VALUES ($1, $2)', [nome, senha ? gerarHashSenha(senha) : null]);
      return responderJSON(res, 201, await listarBarbeiros());
    } catch (erro) {
      return responderJSON(res, 500, { erro: 'Erro ao cadastrar barbeiro.' });
    }
  }

  // API (admin): lista de barbeiros com a informação de quem tem acesso
  if (req.method === 'GET' && rota === '/api/barbeiros/acessos') {
    if (!verificarSenhaAdmin(req)) return responderJSON(res, 401, { erro: 'Acesso negado.' });
    const { rows } = await banco.query('SELECT nome, senha_hash IS NOT NULL AS "temAcesso" FROM barbeiros ORDER BY id');
    return responderJSON(res, 200, rows);
  }

  // API (admin): definir/trocar a senha de um barbeiro  ->  { "senha": "..." }
  // Mandando { "senha": null } tira o acesso dele (continua aparecendo pros clientes)
  if (req.method === 'POST' && /^\/api\/barbeiros\/[^/]+\/senha$/.test(rota)) {
    if (!verificarSenhaAdmin(req)) return responderJSON(res, 401, { erro: 'Acesso negado.' });
    const nome = decodeURIComponent(rota.split('/')[3]);
    const dados = await lerCorpo(req);
    if (dados.senha !== null && !senhaValida(dados.senha)) {
      return responderJSON(res, 400, { erro: 'Senha precisa ter de 6 a 50 caracteres, sem espaço e sem acento.' });
    }
    const resultado = await banco.query('UPDATE barbeiros SET senha_hash = $1 WHERE nome = $2',
      [dados.senha === null ? null : gerarHashSenha(dados.senha), nome]);
    if (resultado.rowCount === 0) return responderJSON(res, 404, { erro: 'Barbeiro não encontrado.' });
    esquecerLogins(); // quem estava logado com a senha antiga precisa entrar de novo
    return responderJSON(res, 200, { ok: true });
  }

  // API: remover barbeiro
  if (req.method === 'DELETE' && rota.startsWith('/api/barbeiros/')) {
    if (!verificarSenhaAdmin(req)) return responderJSON(res, 401, { erro: 'Acesso negado.' });
    const nome = decodeURIComponent(rota.split('/').pop());
    await banco.query('DELETE FROM barbeiros WHERE nome = $1', [nome]);
    esquecerLogins();
    return responderJSON(res, 200, await listarBarbeiros());
  }

  // API: quem sou eu? (a página do barbeiro usa pra se adaptar)
  if (req.method === 'GET' && rota === '/api/eu') {
    if (!req.quem) return responderJSON(res, 401, { erro: 'Acesso negado.' });
    return responderJSON(res, 200, req.quem);
  }

  // API: o barbeiro troca a própria senha  ->  { "atual": "...", "nova": "..." }
  if (req.method === 'POST' && rota === '/api/eu/senha') {
    if (req.quem?.tipo !== 'barbeiro') {
      return responderJSON(res, 403, { erro: 'Só barbeiro com login próprio troca a senha aqui.' });
    }
    const dados = await lerCorpo(req);
    const { rows } = await banco.query('SELECT senha_hash FROM barbeiros WHERE nome = $1', [req.quem.nome]);
    if (!rows.length || !senhaConfere(String(dados.atual || ''), rows[0].senha_hash)) {
      return responderJSON(res, 400, { erro: 'A senha atual está errada.' });
    }
    if (!senhaValida(dados.nova)) {
      return responderJSON(res, 400, { erro: 'A nova senha precisa ter de 6 a 50 caracteres, sem espaço e sem acento.' });
    }
    await banco.query('UPDATE barbeiros SET senha_hash = $1 WHERE nome = $2', [gerarHashSenha(dados.nova), req.quem.nome]);
    esquecerLogins();
    return responderJSON(res, 200, { ok: true });
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
      if (nome.length > 60 || !Number.isInteger(duracao) || duracao > 480 || preco > 10000) {
        return responderJSON(res, 400, { erro: 'Nome até 60 letras, duração de 1 a 480 minutos (número inteiro) e preço até R$10.000.' });
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
    let barbeiroF = url.searchParams.get('barbeiro');
    const dataF = url.searchParams.get('data');
    // Admin e recepção veem os detalhes de todos. Quem não tem login (página do cliente)
    // só fica sabendo quais horários estão ocupados - sem nome nem telefone de ninguém.
    let temLogin = verificarSenhaBarbeiro(req);
    // Barbeiro com login próprio: vê detalhes só dos clientes DELE
    if (req.quem?.tipo === 'barbeiro') {
      if (!barbeiroF) barbeiroF = req.quem.nome;          // página do barbeiro: mostra só a agenda dele
      else if (barbeiroF !== req.quem.nome) temLogin = false; // agenda de outro: só os horários ocupados
    }
    // A página do cliente não precisa ver os cancelados (eles liberam o horário).
    // A página do barbeiro pede com ?todos=1 pra mostrar tudo.
    const mostrarTodos = temLogin && url.searchParams.get('todos') === '1';

    // Monta o filtro só com o que veio na URL
    const condicoes = [];
    const valores = [];
    if (!mostrarTodos) condicoes.push(`status <> 'cancelado'`);
    if (barbeiroF) {
      valores.push(barbeiroF);
      condicoes.push(`barbeiro = $${valores.length}`);
    }
    if (dataF) {
      valores.push(dataF);
      condicoes.push(`data = $${valores.length}`);
    }
    const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

    const colunas = temLogin
      ? 'id, cliente, telefone, email, barbeiro, servico, duracao, preco, data, hora, status'
      : 'barbeiro, data, hora, duracao'; // só o necessário pra riscar os horários ocupados

    const { rows } = await banco.query(
      `SELECT ${colunas} FROM agendamentos ${where} ORDER BY data, hora`,
      valores
    );
    return responderJSON(res, 200, rows);
  }

  // API: criar agendamento
  if (req.method === 'POST' && rota === '/api/agendamentos') {
    // Cliente comum: no máximo 5 agendamentos a cada 15 minutos por IP (evita alguém lotar a agenda de mentira).
    // Barbeiro/admin logado não tem limite (ele pode marcar vários clientes seguidos).
    const logado = verificarSenhaBarbeiro(req);
    if (!logado && passouDoLimite('agendar', req, 5, 15)) {
      return responderJSON(res, 429, { erro: 'Muitos agendamentos seguidos. Espere uns minutos e tente de novo.' });
    }

    const conexao = await banco.connect();
    try {
      const dados = await lerCorpo(req);
      const erro = await validarAgendamento(dados);
      if (erro) return responderJSON(res, 400, { erro });

      const { rows: achados } = await banco.query('SELECT * FROM servicos WHERE nome = $1', [dados.servico]);
      const servico = achados[0];

      const novoAgendamento = {
        cliente: dados.cliente.trim(),
        telefone: (dados.telefone || '').trim(),
        email: (dados.email || '').trim(),
        barbeiro: dados.barbeiro,
        servico: servico.nome,
        duracao: servico.duracao,
        preco: servico.preco,
        data: dados.data.trim(),
        hora: dados.hora.trim()
      };

      // Transação com "trava" por barbeiro e dia: se dois clientes clicarem no mesmo horário
      // ao mesmo tempo, um espera o outro terminar - assim nunca entram os dois.
      await conexao.query('BEGIN');
      await conexao.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${novoAgendamento.barbeiro}|${novoAgendamento.data}`]);

      if (!(await horarioDisponivel(novoAgendamento, conexao))) {
        await conexao.query('ROLLBACK');
        return responderJSON(res, 409, { erro: `${novoAgendamento.barbeiro} já tem um horário marcado nesse período.` });
      }

      const { rows: inseridos } = await conexao.query(
        `INSERT INTO agendamentos (cliente, telefone, email, barbeiro, servico, duracao, preco, data, hora)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          novoAgendamento.cliente, novoAgendamento.telefone, novoAgendamento.email,
          novoAgendamento.barbeiro, novoAgendamento.servico, novoAgendamento.duracao,
          novoAgendamento.preco, novoAgendamento.data, novoAgendamento.hora
        ]
      );
      await conexao.query('COMMIT');
      novoAgendamento.id = inseridos[0].id;
      if (!logado) contarTentativa('agendar', req, 15);

      if (novoAgendamento.email) {
        enviarEmailConfirmacao(novoAgendamento); // não precisa esperar terminar pra responder
      }
      enviarAvisoBarbearia(novoAgendamento); // avisa a barbearia de todo agendamento novo

      return responderJSON(res, 201, novoAgendamento);
    } catch (erro) {
      await conexao.query('ROLLBACK').catch(() => {});
      console.error('Erro ao agendar:', erro.message);
      return responderJSON(res, 500, { erro: 'Erro ao processar o agendamento.' });
    } finally {
      conexao.release(); // devolve a conexão pro banco
    }
  }

  // API: mudar o status de um agendamento (atendido, cancelado ou de volta pra agendado)
  // Exemplo: POST /api/agendamentos/5/status  com  { "status": "atendido" }
  if (req.method === 'POST' && /^\/api\/agendamentos\/\d+\/status$/.test(rota)) {
    if (!verificarSenhaBarbeiro(req)) return responderJSON(res, 401, { erro: 'Acesso negado.' });
    const id = Number(rota.split('/')[3]);
    const dados = await lerCorpo(req);
    const permitidos = ['agendado', 'atendido', 'cancelado'];
    if (!permitidos.includes(dados.status)) {
      return responderJSON(res, 400, { erro: 'Status inválido.' });
    }

    const { rows } = await banco.query('SELECT * FROM agendamentos WHERE id = $1', [id]);
    const agendamento = rows[0];
    if (!agendamento) return responderJSON(res, 404, { erro: 'Agendamento não encontrado.' });
    if (req.quem.tipo === 'barbeiro' && agendamento.barbeiro !== req.quem.nome) {
      return responderJSON(res, 403, { erro: 'Esse agendamento é de outro barbeiro.' });
    }

    // Se for desfazer um cancelamento, o horário pode já ter sido pego por outro cliente
    if (agendamento.status === 'cancelado' && dados.status !== 'cancelado') {
      if (!(await horarioDisponivel(agendamento))) {
        return responderJSON(res, 409, { erro: 'Esse horário já foi ocupado por outro agendamento.' });
      }
    }

    await banco.query('UPDATE agendamentos SET status = $1 WHERE id = $2', [dados.status, id]);
    return responderJSON(res, 200, { ok: true });
  }

  // API antiga de cancelar: agora não apaga mais, só marca como cancelado
  if (req.method === 'DELETE' && rota.startsWith('/api/agendamentos/')) {
    if (!verificarSenhaBarbeiro(req)) return responderJSON(res, 401, { erro: 'Acesso negado.' });
    const id = Number(rota.split('/').pop());
    // Barbeiro só cancela os dele; admin e recepção cancelam qualquer um
    if (req.quem.tipo === 'barbeiro') {
      await banco.query(`UPDATE agendamentos SET status = 'cancelado' WHERE id = $1 AND barbeiro = $2`, [id, req.quem.nome]);
    } else {
      await banco.query(`UPDATE agendamentos SET status = 'cancelado' WHERE id = $1`, [id]);
    }
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
