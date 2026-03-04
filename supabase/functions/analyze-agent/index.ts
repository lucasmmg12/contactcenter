// Edge Function: analyze-agent
// Generates a comprehensive AI-powered profile analysis for a specific agent
// based on all their conversation data, analysis records, and message samples
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
        "authorization, x-client-info, apikey, content-type",
};

const SYSTEM_PROMPT = `Eres un supervisor experto de calidad de atención al cliente en el Sanatorio Argentino (clínica médica en Argentina).
Tu trabajo es generar un PERFIL DE RENDIMIENTO detallado de un agente de contact center basándote en datos reales de sus conversaciones.

Debes ser constructivo pero honesto. Usa datos concretos cuando puedas.
Responde SIEMPRE en español y en JSON válido (sin markdown, sin texto adicional).`;

const ANALYSIS_SCHEMA = `{
  "resumen_ejecutivo": "string - 2-3 oraciones resumen del rendimiento general del agente",
  "puntos_fuertes": [
    {
      "titulo": "string - nombre corto de la fortaleza",
      "descripcion": "string - explicación con datos concretos"
    }
  ],
  "puntos_debiles": [
    {
      "titulo": "string - nombre corto de la debilidad", 
      "descripcion": "string - explicación con datos concretos y contexto"
    }
  ],
  "recomendaciones": [
    {
      "prioridad": "alta|media|baja",
      "titulo": "string - acción recomendada",
      "descripcion": "string - cómo implementar la mejora"
    }
  ],
  "perfil_comunicacion": {
    "estilo_dominante": "string - descripción del estilo de comunicación",
    "palabras_frecuentes": ["string - top 5 palabras que más usa"],
    "nivel_empatia": "alto|medio|bajo",
    "nivel_proactividad": "alto|medio|bajo"
  },
  "score_general": 0.0,
  "nota_final": "string - comentario final motivacional de 1 oración"
}`;

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }

    try {
        const { agent_name, date_from, date_to } = await req.json();

        if (!agent_name) {
            return new Response(
                JSON.stringify({ error: "agent_name is required" }),
                {
                    status: 400,
                    headers: { ...corsHeaders, "Content-Type": "application/json" },
                }
            );
        }

        console.log("Analyzing agent:", agent_name);
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

        // 1. Get all tickets for this agent
        let ticketQuery = supabase
            .from("cc_tickets")
            .select(
                `
        ticket_id,
        received_at,
        customer_name,
        department_name,
        transferred_to_agent,
        bot_handoff_seconds,
        cc_analysis (
          detected_intent,
          category,
          overall_sentiment,
          sentiment_score,
          agent_tone,
          agent_protocol_score,
          agent_greeting,
          agent_farewell,
          agent_response_quality,
          agent_keywords,
          customer_keywords,
          conversation_summary,
          improvement_suggestions,
          first_response_time_seconds,
          message_count,
          agent_message_count
        )
      `
            )
            .eq("agent_name", agent_name)
            .order("received_at", { ascending: false });

        if (date_from) ticketQuery = ticketQuery.gte("received_at", date_from);
        if (date_to) ticketQuery = ticketQuery.lte("received_at", date_to);

        const { data: tickets, error: ticketError } = await ticketQuery;

        if (ticketError) throw new Error(`Error fetching tickets: ${ticketError.message}`);
        if (!tickets || tickets.length === 0) {
            return new Response(
                JSON.stringify({ error: "No tickets found for this agent" }),
                {
                    status: 404,
                    headers: { ...corsHeaders, "Content-Type": "application/json" },
                }
            );
        }

        // 2. Get a sample of actual agent messages (last 30 conversations, agent OUT messages only)
        const sampleTicketIds = tickets.slice(0, 30).map((t: any) => t.ticket_id);

        // Load bot names to filter
        const { data: agentConfig } = await supabase
            .from("cc_agent_config")
            .select("agent_name, role");

        const botNames = new Set(
            (agentConfig || [])
                .filter((a: any) => a.role === "bot")
                .map((a: any) => (a.agent_name as string).toLowerCase())
        );

        const { data: messages } = await supabase
            .from("cc_messages")
            .select("ticket_id, action, sender_name, message")
            .in("ticket_id", sampleTicketIds)
            .eq("action", "OUT")
            .order("message_order", { ascending: true });

        // Filter to only human agent messages (not bot)
        const agentMessages = (messages || []).filter(
            (m: any) => !botNames.has((m.sender_name || "").toLowerCase())
        );

        // 3. Compile statistics
        const analyses = tickets
            .map((t: any) => (Array.isArray(t.cc_analysis) ? t.cc_analysis[0] : t.cc_analysis))
            .filter(Boolean);

        const stats = {
            total_chats: tickets.length,
            sentiments: {} as Record<string, number>,
            avg_sentiment: 0,
            avg_protocol: 0,
            tones: {} as Record<string, number>,
            greeting_rate: 0,
            farewell_rate: 0,
            avg_response_time: 0,
            intents: {} as Record<string, number>,
            all_keywords: {} as Record<string, number>,
            all_summaries: [] as string[],
            all_suggestions: [] as string[],
            handoff_times: [] as number[],
        };

        let sentimentSum = 0, sentimentCount = 0;
        let protocolSum = 0, protocolCount = 0;
        let responseSum = 0, responseCount = 0;
        let greetings = 0, farewells = 0;

        for (const a of analyses) {
            // Sentiments
            if (a.overall_sentiment) {
                stats.sentiments[a.overall_sentiment] = (stats.sentiments[a.overall_sentiment] || 0) + 1;
            }
            if (a.sentiment_score !== null) { sentimentSum += a.sentiment_score; sentimentCount++; }
            if (a.agent_protocol_score !== null) { protocolSum += a.agent_protocol_score; protocolCount++; }
            if (a.first_response_time_seconds) { responseSum += a.first_response_time_seconds; responseCount++; }
            if (a.agent_greeting) greetings++;
            if (a.agent_farewell) farewells++;
            if (a.agent_tone) stats.tones[a.agent_tone] = (stats.tones[a.agent_tone] || 0) + 1;
            if (a.detected_intent) stats.intents[a.detected_intent] = (stats.intents[a.detected_intent] || 0) + 1;
            if (a.agent_keywords) {
                for (const kw of a.agent_keywords) {
                    stats.all_keywords[kw] = (stats.all_keywords[kw] || 0) + 1;
                }
            }
            if (a.conversation_summary) stats.all_summaries.push(a.conversation_summary);
            if (a.improvement_suggestions) {
                for (const s of a.improvement_suggestions) stats.all_suggestions.push(s);
            }
        }

        // Handoff times
        for (const t of tickets) {
            if ((t as any).bot_handoff_seconds) stats.handoff_times.push((t as any).bot_handoff_seconds);
        }

        stats.avg_sentiment = sentimentCount > 0 ? +(sentimentSum / sentimentCount).toFixed(2) : 0;
        stats.avg_protocol = protocolCount > 0 ? +(protocolSum / protocolCount).toFixed(1) : 0;
        stats.avg_response_time = responseCount > 0 ? Math.round(responseSum / responseCount) : 0;
        stats.greeting_rate = tickets.length > 0 ? +((greetings / tickets.length) * 100).toFixed(0) : 0;
        stats.farewell_rate = tickets.length > 0 ? +((farewells / tickets.length) * 100).toFixed(0) : 0;

        // 4. Format agent message samples (limit to avoid token overflow)
        const msgSamples = agentMessages
            .slice(0, 50)
            .map((m: any) => `"${(m.message || "").substring(0, 150)}"`)
            .join("\n");

        // 5. Build prompt
        const topKeywords = Object.entries(stats.all_keywords)
            .sort((a: any, b: any) => b[1] - a[1])
            .slice(0, 15)
            .map(([w, c]) => `${w} (${c})`)
            .join(", ");

        const topSuggestions = [...new Set(stats.all_suggestions)].slice(0, 10).join("\n- ");

        const userPrompt = `Analiza el rendimiento del agente "${agent_name}" del Sanatorio Argentino basándote en estos datos reales:

**ESTADÍSTICAS GENERALES:**
- Total de conversaciones atendidas: ${stats.total_chats}
- Sentimiento promedio de sus pacientes: ${stats.avg_sentiment} (escala -1 a +1)
- Distribución de sentimiento: ${JSON.stringify(stats.sentiments)}
- Score de protocolo promedio: ${stats.avg_protocol}/10
- Tonos detectados: ${JSON.stringify(stats.tones)}
- Tasa de saludo correcto: ${stats.greeting_rate}%
- Tasa de despedida correcta: ${stats.farewell_rate}%
- Tiempo promedio de handoff (bot→agente): ${stats.handoff_times.length > 0 ? Math.round(stats.handoff_times.reduce((a, b) => a + b, 0) / stats.handoff_times.length / 60) + ' minutos' : 'N/A'}
- Intenciones más atendidas: ${JSON.stringify(stats.intents)}

**PALABRAS CLAVE MÁS USADAS POR EL AGENTE:**
${topKeywords || "Sin datos"}

**MUESTRA DE MENSAJES REALES DEL AGENTE (${agentMessages.length} mensajes):**
${msgSamples || "Sin mensajes disponibles"}

**SUGERENCIAS DE MEJORA DETECTADAS EN CONVERSACIONES INDIVIDUALES:**
- ${topSuggestions || "Ninguna"}

**RESÚMENES DE ÚLTIMAS CONVERSACIONES:**
${stats.all_summaries.slice(0, 10).map((s, i) => `${i + 1}. ${s}`).join("\n")}

Genera un perfil de rendimiento completo. Sé constructivo y específico. Usa datos concretos.
Devuelve SOLAMENTE el JSON, sin markdown ni texto adicional.
${ANALYSIS_SCHEMA}`;

        // 6. Call OpenAI
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: SYSTEM_PROMPT },
                    { role: "user", content: userPrompt },
                ],
                temperature: 0.4,
                max_tokens: 2000,
                response_format: { type: "json_object" },
            }),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`OpenAI error: ${response.status} - ${errText}`);
        }

        const data = await response.json();
        const content = data.choices[0].message.content;
        const profile = JSON.parse(content);
        const tokensUsed = data.usage?.total_tokens || 0;

        console.log(`Agent analysis complete for ${agent_name}, tokens: ${tokensUsed}`);

        return new Response(
            JSON.stringify({
                success: true,
                agent_name,
                total_chats_analyzed: stats.total_chats,
                profile,
                tokens_used: tokensUsed,
            }),
            {
                status: 200,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            }
        );
    } catch (error) {
        console.error("Agent analysis error:", error);
        return new Response(
            JSON.stringify({ error: (error as Error).message }),
            {
                status: 500,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            }
        );
    }
});
