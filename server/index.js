const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');
const authMiddleware = require('./middleware/auth'); // Importa o nosso "segurança"

const app = express();
const port = 3001;

// Middlewares
app.use(cors());
app.use(express.json());

// --- ROTAS DA API ---

// Rota de teste
app.get('/', (req, res) => {
  res.send('Servidor do SIA-QME está no ar!');
});

// Rota para buscar todas as queixas - VERSÃO FINAL COM BUSCA E FILTROS
app.get('/api/complaints', authMiddleware, async (req, res) => {
  if (req.user.role !== 'HEALTH_PROFESSIONAL' && req.user.role !== 'MANAGER') {
    return res.status(403).json({ error: 'Acesso não autorizado.' });
  }

  // --- LÓGICA NOVA PARA FILTROS ---
  // 1. Lemos os parâmetros da URL. Ex: /api/complaints?search=Vinicius&location=Ombro
  const { search, location } = req.query;

  // 2. Construímos a query SQL dinamicamente
  let baseQuery = `
    SELECT 
      complaints.id,
      complaints.location,
      complaints.intensity,
      users.name AS pilot_name 
    FROM 
      complaints
    JOIN 
      users ON complaints.pilot_user_id = users.id
  `;

  const whereClauses = [];
  const values = [];
  let paramIndex = 1;

  // Se houver um termo de busca, adicionamos uma condição para o nome do piloto
  if (search) {
    // Usamos ILIKE para uma busca case-insensitive (não diferencia maiúsculas de minúsculas)
    // O '%' é um coringa que significa "qualquer sequência de caracteres"
    whereClauses.push(`users.name ILIKE $${paramIndex}`);
    values.push(`%${search}%`);
    paramIndex++;
  }

  // Se houver um local selecionado, adicionamos uma condição para o local da queixa
  if (location) {
    whereClauses.push(`complaints.location = $${paramIndex}`);
    values.push(location);
    paramIndex++;
  }

  // Se houver alguma cláusula WHERE, nós as juntamos à query base
  if (whereClauses.length > 0) {
    baseQuery += ` WHERE ${whereClauses.join(' AND ')}`;
  }

  // Adicionamos a ordenação no final
  baseQuery += ` ORDER BY complaints.id DESC;`;

  // --- FIM DA LÓGICA NOVA ---

  try {
    // 3. Executamos a query final com os valores dos filtros
    const result = await db.query(baseQuery, values);
    res.status(200).json(result.rows);

  } catch (error) {
    console.error('Erro ao buscar queixas:', error);
    res.status(500).json({ error: 'Ocorreu um erro ao buscar os dados das queixas.' });
  }
});

// ROTA PARA BUSCAR O PERFIL DO USUÁRIO LOGADO
app.get('/api/profile', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  try {
    const profileQuery = `
      SELECT u.name, u.email, pp.* FROM users u
      LEFT JOIN pilot_profiles pp ON u.id = pp.user_id
      WHERE u.id = $1;
    `;
    const result = await db.query(profileQuery, [userId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Perfil não encontrado.' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao buscar perfil:', error);
    res.status(500).json({ error: 'Erro no servidor ao buscar perfil.' });
  }
});

// ROTA PARA ATUALIZAR O PERFIL DO PILOTO
app.put('/api/profile', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const { rank, organization, aircraft_type, weight_kg, height_m, birth_date } = req.body;

  try {
    const updateQuery = `
      UPDATE pilot_profiles
      SET 
        rank = $1,
        organization = $2,
        aircraft_type = $3,
        weight_kg = $4,
        height_m = $5,
        birth_date = $6
      WHERE user_id = $7
      RETURNING *;
    `;
    const values = [rank, organization, aircraft_type, weight_kg, height_m, birth_date, userId];
    const result = await db.query(updateQuery, values);

    if (result.rows.length === 0) {
      // Se o perfil não existe, cria um (UPSERT)
      const insertQuery = `
        INSERT INTO pilot_profiles (user_id, rank, organization, aircraft_type, weight_kg, height_m, birth_date)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *;
      `;
      const insertValues = [userId, rank, organization, aircraft_type, weight_kg, height_m, birth_date];
      const insertResult = await db.query(insertQuery, insertValues);
      return res.status(201).json(insertResult.rows[0]);
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao atualizar perfil:', error);
    res.status(500).json({ error: 'Erro no servidor ao atualizar perfil.' });
  }
});

/**
 * ROTA PARA SALVAR UMA NOVA QUEIXA (VERSÃO COM VALIDAÇÃO DE DADOS)
 */
app.post('/api/complaints', authMiddleware, async (req, res) => {
  console.log('Dados recebidos no backend:', JSON.stringify(req.body, null, 2));

  const pilot_user_id = req.user.id;
  const { 
    step2_location, 
    step3_details, 
    step4_history
  } = req.body;

  // --- AQUI ESTÁ A CORREÇÃO ---
  // 1. Adicionamos uma verificação de segurança.
  // Se o objeto step2_location não existir, ou se a propriedade location dentro dele estiver vazia,
  // nós retornamos um erro claro e não prosseguimos.
  if (!step2_location || !step2_location.location) {
    return res.status(400).json({ error: 'A localização da queixa é um campo obrigatório.' });
  }

  // Se a validação passar, o resto do código continua.
  const impactMapping = {
    'sem_impacto': 0,
    'impacto_leve': 1,
    'impacto_moderado': 2,
    'incapaz_voar': 3
  };
  const flightImpactAsNumber = impactMapping[step3_details?.flightImpact] || 0;

  const insertQuery = `
    INSERT INTO complaints (
      pilot_user_id, 
      location,
      intensity,
      flight_performance_impact,
      loss_of_movement,
      used_medication,
      onset,
      history
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *; 
  `;
  
  const values = [
    pilot_user_id,
    step2_location.location, // Agora temos certeza que este valor existe
    step3_details?.intensity,
    flightImpactAsNumber,
    step3_details?.lossOfMovement ? 'Sim' : 'Não',
    step3_details?.medicationUsed ? 'Sim' : 'Não',
    step4_history?.onset,
    step4_history?.history
  ];

  try {
    const result = await db.query(insertQuery, values);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Erro detalhado ao salvar queixa:', error);
    res.status(500).json({ error: 'Ocorreu um erro ao salvar a queixa no banco de dados.' });
  }
});

/**
 * ROTA PARA SALVAR UMA NOVA AVALIAÇÃO DO IPAQ
 */
app.post('/api/assessments/ipaq', authMiddleware, async (req, res) => {
  // Pega o ID do piloto logado a partir do token
  const { id: userId, role } = req.user;

  // Garante que apenas pilotos podem registrar essa avaliação
  if (role !== 'PILOT') {
    return res.status(403).json({ error: 'Apenas pilotos podem registrar uma avaliação IPAQ.' });
  }

  // Pega os dados do formulário enviados pelo frontend
  const {
    vigorous_activity_days,
    vigorous_activity_minutes,
    moderate_activity_days,
    moderate_activity_minutes,
    walking_days,
    walking_minutes,
    sitting_minutes
  } = req.body;

  const insertQuery = `
    INSERT INTO ipaq_assessments (
      user_id, vigorous_activity_days, vigorous_activity_minutes, 
      moderate_activity_days, moderate_activity_minutes, walking_days, 
      walking_minutes, sitting_minutes
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id;
  `;

  const values = [
    userId,
    vigorous_activity_days,
    vigorous_activity_minutes,
    moderate_activity_days,
    moderate_activity_minutes,
    walking_days,
    walking_minutes,
    sitting_minutes
  ];

  try {
    const result = await db.query(insertQuery, values);
    return res.status(201).json({ 
      message: 'Avaliação IPAQ salva com sucesso!', 
      assessmentId: result.rows[0].id 
    });
  } catch (error) {
    console.error('Erro ao salvar avaliação IPAQ:', error);
    return res.status(500).json({ error: 'Ocorreu um erro ao salvar a avaliação.' });
  }
});

// ================================================================================================
// ESTA É A VERSÃO FINAL COM O NOME CORRETO DA COLUNA DE DATA
// ================================================================================================
app.get('/api/complaints/:id', authMiddleware, async (req, res) => {
  if (req.user.role !== 'HEALTH_PROFESSIONAL' && req.user.role !== 'MANAGER') {
    return res.status(403).json({ error: 'Acesso não autorizado.' });
  }

  const { id } = req.params;

  try {
    const complaintQuery = `
      SELECT 
        c.*, 
        u.name AS pilot_name, u.email,
        pp.weight_kg, 
        pp.height_m
      FROM complaints c
      JOIN users u ON c.pilot_user_id = u.id
      LEFT JOIN pilot_profiles pp ON u.id = pp.user_id
      WHERE c.id = $1;
    `;
    const complaintResult = await db.query(complaintQuery, [id]);

    if (complaintResult.rows.length === 0) {
      return res.status(404).json({ error: 'Queixa não encontrada.' });
    }
    const complaintData = complaintResult.rows[0];
    const pilotId = complaintData.pilot_user_id;

    // ================================================================
    // CORREÇÃO FINAL: Usando o nome da coluna que encontramos ('assessment_date')
    // ================================================================
    const ipaqResult = await db.query('SELECT * FROM ipaq_assessments WHERE user_id = $1 ORDER BY assessment_date DESC LIMIT 1', [pilotId]);
    const nasaTlxResult = await db.query('SELECT * FROM nasa_tlx_assessments WHERE user_id = $1 ORDER BY assessment_date DESC LIMIT 1', [pilotId]);
    
    const ipaqData = ipaqResult.rows[0];
    const nasaTlxData = nasaTlxResult.rows[0];

    // --- Lógica de Negócio (já corrigida anteriormente) ---
    let imc = null;
    if (complaintData.weight_kg && complaintData.height_m) {
      const heightInMeters = parseFloat(complaintData.height_m);
      if (heightInMeters > 0) {
        imc = (parseFloat(complaintData.weight_kg) / (heightInMeters * heightInMeters)).toFixed(2);
      }
    }
    
    let isActive = false;
    let totalMinutes = 0;
    if (ipaqData) {
      const vigorousMinutes = (ipaqData.vigorous_activity_days || 0) * (ipaqData.vigorous_activity_minutes || 0);
      const moderateMinutes = (ipaqData.moderate_activity_days || 0) * (ipaqData.moderate_activity_minutes || 0);
      totalMinutes = vigorousMinutes + moderateMinutes;
      isActive = totalMinutes > 300;
    }
    
    const responsePayload = {
      complaint: complaintData,
      pilotProfile: {
        weight: complaintData.weight_kg,
        height: complaintData.height_m,
        imc: imc,
      },
      activityLevel: {
        isActive: isActive,
        totalMinutes: totalMinutes,
        details: ipaqData,
      },
      nasaTlx: nasaTlxData,
    };

    res.status(200).json(responsePayload);

  } catch (error) {
    console.error(`Erro ao buscar detalhes da queixa ${id}:`, error);
    res.status(500).json({ error: 'Erro no servidor ao buscar detalhes da queixa.' });
  }
});

/**
 * ROTA PARA SALVAR UMA NOVA AVALIAÇÃO DO NASA-TLX
 */
app.post('/api/assessments/nasa-tlx', authMiddleware, async (req, res) => {
  // Pega o ID do piloto logado a partir do token
  const { id: userId, role } = req.user;

  // Garante que apenas pilotos podem registrar
  if (role !== 'PILOT') {
    return res.status(403).json({ error: 'Apenas pilotos podem registrar uma avaliação NASA-TLX.' });
  }

  // Pega todos os dados do formulário enviados pelo frontend
  const {
    mental_demand_rating, physical_demand_rating, temporal_demand_rating,
    performance_rating, effort_rating, frustration_rating,
    mental_demand_weight, physical_demand_weight, temporal_demand_weight,
    performance_weight, effort_weight, frustration_weight,
    overall_score
  } = req.body;

  const insertQuery = `
    INSERT INTO nasa_tlx_assessments (
      user_id, mental_demand_rating, physical_demand_rating, temporal_demand_rating,
      performance_rating, effort_rating, frustration_rating,
      mental_demand_weight, physical_demand_weight, temporal_demand_weight,
      performance_weight, effort_weight, frustration_weight, overall_score
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    RETURNING id;
  `;

  const values = [
    userId, mental_demand_rating, physical_demand_rating, temporal_demand_rating,
    performance_rating, effort_rating, frustration_rating,
    mental_demand_weight, physical_demand_weight, temporal_demand_weight,
    performance_weight, effort_weight, frustration_weight, overall_score
  ];

  try {
    const result = await db.query(insertQuery, values);
    return res.status(201).json({
      message: 'Avaliação NASA-TLX salva com sucesso!',
      assessmentId: result.rows[0].id
    });
  } catch (error) {
    console.error('Erro ao salvar avaliação NASA-TLX:', error);
    return res.status(500).json({ error: 'Ocorreu um erro ao salvar a avaliação NASA-TLX.' });
  }
});

// ROTA PARA UM PILOTO BUSCAR OS DETALHES DE UMA QUEIXA E SEU PARECER (VERSÃO COM "MARCAR COMO LIDO")
app.get('/api/my-complaints/:id', authMiddleware, async (req, res) => {
    const { id: complaintId } = req.params;
    const pilotUserId = req.user.id;

    if (req.user.role !== 'PILOT') {
        return res.status(403).json({ error: 'Acesso negado.' });
    }

    try {
        // 1. Busca os dados da queixa (sem alteração aqui)
        const complaintQuery = `
            SELECT id, location, intensity, submission_date, onset, history,
                   flight_performance_impact, loss_of_movement, used_medication
            FROM complaints
            WHERE id = $1 AND pilot_user_id = $2;
        `;
        const complaintResult = await db.query(complaintQuery, [complaintId, pilotUserId]);

        if (complaintResult.rows.length === 0) {
            return res.status(404).json({ error: 'Queixa não encontrada ou acesso não permitido.' });
        }
        const complaintData = complaintResult.rows[0];

        // 2. Busca o parecer associado (sem alteração aqui)
        const assessmentQuery = `
            SELECT ha.id, ha.diagnosis, ha.treatment_plan, ha.notes, ha.assessment_date, u.name as professional_name
            FROM health_assessments ha
            JOIN users u ON ha.assessing_professional_id = u.id
            WHERE ha.complaint_id = $1;
        `;
        const assessmentResult = await db.query(assessmentQuery, [complaintId]);
        const assessmentData = assessmentResult.rows[0] || null;

        // ==================================================================
        // ★★★ NOVA LÓGICA ADICIONADA AQUI ★★★
        // 3. Se um parecer foi encontrado, marque-o como visto pelo piloto.
        // Fazemos isso DEPOIS de buscar os dados com sucesso.
        if (assessmentData) {
            const updateSeenQuery = `
                UPDATE health_assessments
                SET pilot_has_seen = TRUE
                WHERE id = $1;
            `;
            await db.query(updateSeenQuery, [assessmentData.id]);
        }
        // ==================================================================

        // 4. Combina tudo em uma única resposta (sem alteração aqui)
        const responsePayload = {
            complaint: complaintData,
            assessment: assessmentData
        };

        res.status(200).json(responsePayload);

    } catch (error) {
        console.error(`Erro ao buscar detalhes da queixa ${complaintId} para o piloto ${pilotUserId}:`, error);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// ROTA PARA CONTAR NOTIFICAÇÕES NÃO LIDAS DE UM PILOTO
app.get('/api/notifications/count', authMiddleware, async (req, res) => {
    const pilotUserId = req.user.id;

    if (req.user.role !== 'PILOT') {
        // Não é um erro, apenas retorna 0 para outros perfis
        return res.status(200).json({ unreadCount: 0 });
    }

    try {
        const countQuery = `
            SELECT COUNT(*)
            FROM health_assessments ha
            JOIN complaints c ON ha.complaint_id = c.id
            WHERE c.pilot_user_id = $1 AND ha.pilot_has_seen = FALSE;
        `;
        const result = await db.query(countQuery, [pilotUserId]);
        
        // O resultado de COUNT(*) é uma string, então convertemos para número
        const unreadCount = parseInt(result.rows[0].count, 10);

        res.status(200).json({ unreadCount });

    } catch (error) {
        console.error(`Erro ao contar notificações para o piloto ${pilotUserId}:`, error);
        res.status(500).json({ error: 'Erro ao buscar contagem de notificações.' });
    }
});

// ROTA PARA UM PILOTO BUSCAR SEUS PRÓPRIOS PARECERES DE SAÚDE
app.get('/api/my-assessments', authMiddleware, async (req, res) => {
  const pilotId = req.user.id; // Pega o ID do piloto logado a partir do token

  // Garante que apenas usuários com o perfil de piloto possam acessar
  if (req.user.role !== 'PILOT') {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  try {
    const query = `
      SELECT 
        ha.id,
        ha.diagnosis,
        ha.treatment_plan,
        ha.notes,
        ha.assessment_date,
        c.location AS complaint_location,
        c.submission_date AS complaint_date,
        u.name AS professional_name
      FROM 
        health_assessments ha
      JOIN 
        complaints c ON ha.complaint_id = c.id
      JOIN
        users u ON ha.assessing_professional_id = u.id
      WHERE 
        c.pilot_user_id = $1
      ORDER BY 
        ha.assessment_date DESC;
    `;
    
    const result = await db.query(query, [pilotId]);
    res.status(200).json(result.rows);

  } catch (error) {
    console.error(`Erro ao buscar pareceres para o piloto ${pilotId}:`, error);
    res.status(500).json({ error: 'Ocorreu um erro ao buscar seus pareceres.' });
  }
});

// ROTA PARA UM PILOTO BUSCAR SUAS PRÓPRIAS QUEIXAS
app.get('/api/my-complaints', authMiddleware, async (req, res) => {
    // Pega o ID do piloto logado a partir do token (que o authMiddleware já verificou)
    const pilotUserId = req.user.id; 

    // Garante que o usuário tem a permissão de 'PILOT'
    if (req.user.role !== 'PILOT') {
        return res.status(403).json({ error: 'Acesso negado. Apenas pilotos podem ver suas queixas.' });
    }

    try {
        const query = `
            SELECT 
                c.id,
                c.location as main_complaint, -- Usando 'location' como o nome principal da queixa na lista
                c.submission_date,
                -- A consulta abaixo verifica se já existe um parecer na tabela health_assessments
                CASE 
                    WHEN EXISTS (SELECT 1 FROM health_assessments ha WHERE ha.complaint_id = c.id)
                    THEN 'Parecer Disponível'
                    ELSE 'Aguardando Avaliação'
                END as assessment_status
            FROM 
                complaints c
            WHERE 
                c.pilot_user_id = $1
            ORDER BY 
                c.submission_date DESC;
        `;
        
        const { rows } = await db.query(query, [pilotUserId]);
        
        res.status(200).json(rows);

    } catch (error) {
        console.error('Erro ao buscar queixas do piloto:', error);
        res.status(500).json({ error: 'Erro interno do servidor ao buscar as queixas.' });
    }
});

// Rotas de Autenticação
// ROTA PARA REGISTRAR UM NOVO USUÁRIO - VERSÃO CORRIGIDA
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, role } = req.body;

  if (!name || !email || !password || !role) {
    // Adiciona 'return'
    return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
  }

  try {
    const existingUser = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      // Adiciona 'return'
      return res.status(409).json({ error: 'Este e-mail já está em uso.' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const newUserResult = await db.query(
      'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role',
      [name, email, passwordHash, role]
    );
    const newUser = newUserResult.rows[0];
    
    if (newUser.role === 'PILOT') {
        await db.query('INSERT INTO pilot_profiles (user_id) VALUES ($1)', [newUser.id]);
    }

    // Adiciona 'return'
    return res.status(201).json(newUser);

  } catch (error) {
    console.error('Erro no registro:', error);
    // Adiciona 'return'
    return res.status(500).json({ error: 'Ocorreu um erro no servidor.' });
  }
});

// Substitua a sua rota de login por esta versão com "espiões"
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
    }

    try {
        const userResult = await db.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userResult.rows.length === 0) {
            return res.status(401).json({ error: 'Credenciais inválidas.' });
        }
        const user = userResult.rows[0];

        const isPasswordCorrect = await bcrypt.compare(password, user.password_hash);
        if (!isPasswordCorrect) {
            return res.status(401).json({ error: 'Credenciais inválidas.' });
        }

        const payload = {
            id: user.id,
            name: user.name,
            role: user.role
        };
        const token = jwt.sign(
            payload,
            process.env.JWT_SECRET,
            { expiresIn: '8h' }
        );

        // A correção é adicionar o "return" aqui
        return res.status(200).json({ token, user: payload });

    } catch (error) {
        console.error('Erro no login:', error);
        // Também adicionamos um "return" aqui por segurança
        return res.status(500).json({ error: 'Ocorreu um erro no servidor.' });
    }
});

// ROTA PARA REGISTRAR UM NOVO USUÁRIO - VERSÃO CORRIGIDA
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, role } = req.body;

  if (!name || !email || !password || !role) {
    // Adiciona 'return'
    return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
  }

  try {
    const existingUser = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      // Adiciona 'return'
      return res.status(409).json({ error: 'Este e-mail já está em uso.' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const newUserResult = await db.query(
      'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role',
      [name, email, passwordHash, role]
    );
    const newUser = newUserResult.rows[0];
    
    if (newUser.role === 'PILOT') {
        await db.query('INSERT INTO pilot_profiles (user_id) VALUES ($1)', [newUser.id]);
    }

    // Adiciona 'return'
    return res.status(201).json(newUser);

  } catch (error) {
    console.error('Erro no registro:', error);
    // Adiciona 'return'
    return res.status(500).json({ error: 'Ocorreu um erro no servidor.' });
  }
});

// Inicia o Servidor
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});

/**
 * ROTA PARA SALVAR UMA NOVA ANÁLISE DO PROFISSIONAL DE SAÚDE
 */
app.post('/api/assessments', authMiddleware, async (req, res) => {
  // Apenas profissionais de saúde podem enviar um parecer
  if (req.user.role !== 'HEALTH_PROFESSIONAL') {
    return res.status(403).json({ error: 'Acesso negado. Apenas profissionais de saúde podem adicionar análises.' });
  }

  // Pega os dados enviados pelo formulário do frontend
  const { complaint_id, diagnosis, treatment_plan, notes } = req.body;
  // Pega o ID do profissional que está logado (a partir do token)
  const assessing_professional_id = req.user.id;

  // Validação simples para garantir que os campos não estão vazios
  if (!complaint_id || !diagnosis || !treatment_plan) {
    return res.status(400).json({ error: 'ID da Queixa, Diagnóstico e Plano de Tratamento são obrigatórios.' });
  }

  const insertQuery = `
    INSERT INTO health_assessments 
      (complaint_id, assessing_professional_id, diagnosis, treatment_plan, notes)
    VALUES ($1, $2, $3, $4, $5) RETURNING *;
  `;
  const values = [complaint_id, assessing_professional_id, diagnosis, treatment_plan, notes || null];

  try {
    const result = await db.query(insertQuery, values);
    // Envia uma resposta JSON de sucesso, como o frontend espera
    res.status(201).json({ message: 'Parecer salvo com sucesso!', assessment: result.rows[0] });
  } catch (error) {
    console.error('Erro ao salvar parecer:', error);
    res.status(500).json({ error: 'Ocorreu um erro no servidor ao salvar o parecer.' });
  }
});