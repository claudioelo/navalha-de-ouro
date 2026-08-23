// servidor.js
// Servidor da Navalha de Ouro - agendamentos
// Usa só módulos nativos do Node (http, fs, path) - sem precisar instalar nada com npm

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORTA = process.env.PORT || 3000;
const PASTA_DADOS = path.join(__dirname, 'dados');
const ARQ_AGENDAMENTOS = path.join(PASTA_DADOS, 'agendamentos.json');
const ARQ_BARBEIROS = path.join(PASTA_DADOS, 'barbeiros.json');
const ARQ_SERVICOS = path.join(PASTA_DADOS, 'servicos.json');
const PASTA_PUBLIC = path.join(__dirname, 'public');

// ---------- Configuração de e-mail (opcional) ----------
// Pra ativar o envio de e-mail de verdade, crie uma conta grátis em https://resend.com,
// pegue sua API key e cole abaixo. Enquanto RESEND_API_KEY estiver vazio,
// o sistema só mostra no console o que teria sido enviado (não dá erro, só não manda de verdade).
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_REMETENTE = 'onboarding@resend.dev'; // troque depois de configurar o Resend

async function enviarEmailConfirmacao(agendamento) {
  const assunto = 'Agendamento confirmado - Navalha de Ouro';
  const corpo = `
    Agendamento realizado com sucesso!

    Cliente: ${agendamento.cliente}
    Barbeiro: ${agendamento.barbeiro}
    Serviço: ${agendamento.servico}
    Data: ${agendamento.data}
    Horário: ${agendamento.hora}
  `;

  if (!RESEND_API_KEY) {
    console.log('--- E-mail NÃO enviado (RESEND_API_KEY não configurada) ---');
    console.log(`Para: ${agendamento.email}`);
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
        to: agendamento.email,
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

// ---------- Funções de leitura/gravação (mesmo padrão do produtos.json) ----------
function garantirArquivos() {
  if (!fs.existsSync(PASTA_DADOS)) fs.mkdirSync(PASTA_DADOS);

  if (!fs.existsSync(ARQ_AGENDAMENTOS)) {
    fs.writeFileSync(ARQ_AGENDAMENTOS, '[]');
  }
  if (!fs.existsSync(ARQ_BARBEIROS)) {
    fs.writeFileSync(ARQ_BARBEIROS, JSON.stringify(['Carlos', 'Marcelo', 'Diego'], null, 2));
  }
  if (!fs.existsSync(ARQ_SERVICOS)) {
    fs.writeFileSync(ARQ_SERVICOS, JSON.stringify([
      { nome: 'Corte', duracao: 30, preco: 35 },
      { nome: 'Barba', duracao: 20, preco: 25 },
      { nome: 'Corte + Barba', duracao: 45, preco: 55 },
      { nome: 'Sobrancelha', duracao: 10, preco: 15 }
    ], null, 2));
  }
}

function lerJSON(caminho) {
  return JSON.parse(fs.readFileSync(caminho, 'utf-8'));
}

function salvarJSON(caminho, dados) {
  fs.writeFileSync(caminho, JSON.stringify(dados, null, 2));
}

// ---------- Regra de conflito de horário (mesma lógica de antes) ----------
function horarioDisponivel(novo, ignorarId = null) {
  const agendamentos = lerJSON(ARQ_AGENDAMENTOS);
  const inicioNovo = new Date(`${novo.data}T${novo.hora}`);
  const fimNovo = new Date(inicioNovo.getTime() + novo.duracao * 60000);

  for (const ag of agendamentos) {
    if (ag.id === ignorarId) continue;
    if (ag.barbeiro !== novo.barbeiro) continue;

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
garantirArquivos();

const servidor = http.createServer(async (req, res) => {
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

  // Página de admin
  if (req.method === 'GET' && rota === '/admin') {
    return servirArquivoEstatico(res, path.join(PASTA_PUBLIC, 'admin.html'));
  }

  // API: barbeiros e serviços (pra preencher os selects)
  if (req.method === 'GET' && rota === '/api/barbeiros') {
    return responderJSON(res, 200, lerJSON(ARQ_BARBEIROS));
  }
  if (req.method === 'GET' && rota === '/api/servicos') {
    return responderJSON(res, 200, lerJSON(ARQ_SERVICOS));
  }

  // API: cadastrar barbeiro
  if (req.method === 'POST' && rota === '/api/barbeiros') {
    try {
      const dados = await lerCorpo(req);
      const nome = (dados.nome || '').trim();
      if (!nome) return responderJSON(res, 400, { erro: 'Informe o nome do barbeiro.' });

      const barbeiros = lerJSON(ARQ_BARBEIROS);
      if (barbeiros.includes(nome)) {
        return responderJSON(res, 409, { erro: 'Esse barbeiro já está cadastrado.' });
      }
      barbeiros.push(nome);
      salvarJSON(ARQ_BARBEIROS, barbeiros);
      return responderJSON(res, 201, barbeiros);
    } catch (erro) {
      return responderJSON(res, 500, { erro: 'Erro ao cadastrar barbeiro.' });
    }
  }

  // API: remover barbeiro
  if (req.method === 'DELETE' && rota.startsWith('/api/barbeiros/')) {
    const nome = decodeURIComponent(rota.split('/').pop());
    let barbeiros = lerJSON(ARQ_BARBEIROS);
    barbeiros = barbeiros.filter((b) => b !== nome);
    salvarJSON(ARQ_BARBEIROS, barbeiros);
    return responderJSON(res, 200, barbeiros);
  }

  // API: cadastrar serviço
  if (req.method === 'POST' && rota === '/api/servicos') {
    try {
      const dados = await lerCorpo(req);
      const nome = (dados.nome || '').trim();
      const duracao = Number(dados.duracao);
      const preco = Number(dados.preco);

      if (!nome || !duracao || duracao <= 0 || isNaN(preco) || preco < 0) {
        return responderJSON(res, 400, { erro: 'Preencha nome, duração (min) e preço corretamente.' });
      }

      const servicos = lerJSON(ARQ_SERVICOS);
      if (servicos.some((s) => s.nome === nome)) {
        return responderJSON(res, 409, { erro: 'Já existe um serviço com esse nome.' });
      }
      servicos.push({ nome, duracao, preco });
      salvarJSON(ARQ_SERVICOS, servicos);
      return responderJSON(res, 201, servicos);
    } catch (erro) {
      return responderJSON(res, 500, { erro: 'Erro ao cadastrar serviço.' });
    }
  }

  // API: remover serviço
  if (req.method === 'DELETE' && rota.startsWith('/api/servicos/')) {
    const nome = decodeURIComponent(rota.split('/').pop());
    let servicos = lerJSON(ARQ_SERVICOS);
    servicos = servicos.filter((s) => s.nome !== nome);
    salvarJSON(ARQ_SERVICOS, servicos);
    return responderJSON(res, 200, servicos);
  }

  // API: listar agendamentos (com filtro opcional por barbeiro e data)
  if (req.method === 'GET' && rota === '/api/agendamentos') {
    let lista = lerJSON(ARQ_AGENDAMENTOS);
    const barbeiroF = url.searchParams.get('barbeiro');
    const dataF = url.searchParams.get('data');
    if (barbeiroF) lista = lista.filter((a) => a.barbeiro === barbeiroF);
    if (dataF) lista = lista.filter((a) => a.data === dataF);
    lista.sort((a, b) => (a.data + a.hora).localeCompare(b.data + b.hora));
    return responderJSON(res, 200, lista);
  }

  // API: criar agendamento
  if (req.method === 'POST' && rota === '/api/agendamentos') {
    try {
      const dados = await lerCorpo(req);
      const servicos = lerJSON(ARQ_SERVICOS);
      const servico = servicos.find((s) => s.nome === dados.servico);

      if (!dados.cliente || !dados.barbeiro || !servico || !dados.data || !dados.hora) {
        return responderJSON(res, 400, { erro: 'Preencha todos os campos obrigatórios.' });
      }

      const novoAgendamento = {
        id: Date.now(),
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

      if (!horarioDisponivel(novoAgendamento)) {
        return responderJSON(res, 409, { erro: `${dados.barbeiro} já tem um horário marcado nesse período.` });
      }

      const agendamentos = lerJSON(ARQ_AGENDAMENTOS);
      agendamentos.push(novoAgendamento);
      salvarJSON(ARQ_AGENDAMENTOS, agendamentos);

      if (novoAgendamento.email) {
        enviarEmailConfirmacao(novoAgendamento); // não precisa esperar terminar pra responder
      }

      return responderJSON(res, 201, novoAgendamento);
    } catch (erro) {
      return responderJSON(res, 500, { erro: 'Erro ao processar o agendamento.' });
    }
  }

  // API: cancelar agendamento
  if (req.method === 'DELETE' && rota.startsWith('/api/agendamentos/')) {
    const id = Number(rota.split('/').pop());
    let agendamentos = lerJSON(ARQ_AGENDAMENTOS);
    agendamentos = agendamentos.filter((a) => a.id !== id);
    salvarJSON(ARQ_AGENDAMENTOS, agendamentos);
    return responderJSON(res, 200, { ok: true });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Rota não encontrada');
});

servidor.listen(PORTA, () => {
  console.log(`Servidor da Navalha de Ouro rodando em http://localhost:${PORTA}`);
  console.log(`Página do cliente: http://localhost:${PORTA}/`);
  console.log(`Página do barbeiro: http://localhost:${PORTA}/barbeiro`);
});
