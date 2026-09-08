"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { patients, type Patient } from "@/lib/mock-data";
import { agentQuery } from "@/lib/patient-portal";
import { fetchApi } from "@/lib/backend-api";
import {
  Send,
  Bot,
  User,
  Sparkles,
  Brain,
  Database,
  FileSearch,
  Zap,
  Mic,
  Paperclip,
  MoreHorizontal,
  Plus,
  MessageSquare,
  Trash2,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

interface ChatSession {
  id: string;
  title: string;
  selectedPatientId: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
}

const CHAT_STORAGE_KEY = "medai-chat-sessions-v1";

const aiCapabilities = [
  { icon: Brain, title: "Clinical Analysis", color: "bg-muted text-foreground" },
  { icon: Database, title: "RAG System", color: "bg-muted text-foreground" },
  { icon: FileSearch, title: "Drug Check", color: "bg-muted text-foreground" },
  { icon: Zap, title: "Trend AI", color: "bg-muted text-foreground" },
];

const quickPrompts = [
  { label: "Critical patients", query: "List all patients with critical status" },
  { label: "Drug interactions", query: "Check for any drug interactions in current medications" },
  { label: "Lab trends", query: "What are the current trends in HbA1c levels?" },
  { label: "Overdue tests", query: "Which patients have overdue tests?" },
];

const ALL_PATIENTS_VALUE = "all-patients";

const createChatSession = (): ChatSession => {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: "New Chat",
    selectedPatientId: "",
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
};

function renderInlineText(text: string) {
  const segments = text.split(/(\*\*[^*]+\*\*)/g);
  return segments.map((segment, index) => {
    const isBold = segment.startsWith("**") && segment.endsWith("**") && segment.length > 4;
    if (!isBold) return <span key={`${segment}-${index}`}>{segment}</span>;
    return <strong key={`${segment}-${index}`}>{segment.slice(2, -2)}</strong>;
  });
}

function FormattedMessage({ content }: { content: string }) {
  const lines = content.split("\n");
  const blocks: React.ReactNode[] = [];

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      blocks.push(<div key={`spacer-${index}`} className="h-1" />);
      index += 1;
      continue;
    }

    // Markdown Table Parser
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      const tableLines: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith("|") && lines[index].trim().endsWith("|")) {
        tableLines.push(lines[index].trim());
        index += 1;
      }
      if (tableLines.length >= 2) {
        const headerCells = tableLines[0].split("|").slice(1, -1).map((c) => c.trim());
        const isSeparator = /^\|[-:\s|]+\|$/.test(tableLines[1]);
        const startDataIdx = isSeparator ? 2 : 1;
        const dataRows = tableLines.slice(startDataIdx).map((row) =>
          row.split("|").slice(1, -1).map((c) => c.trim())
        );

        blocks.push(
          <div key={`table-${index}`} className="my-3 overflow-x-auto rounded-xl border border-border/70 bg-card/60 shadow-sm">
            <table className="w-full border-collapse text-xs">
              <thead className="bg-muted/80 text-foreground font-semibold">
                <tr>
                  {headerCells.map((h, hi) => (
                    <th key={`th-${hi}`} className="border-b border-border/70 px-3 py-2 text-left">
                      {renderInlineText(h)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {dataRows.map((row, ri) => (
                  <tr key={`tr-${ri}`} className="hover:bg-muted/30 transition-colors">
                    {row.map((cell, ci) => (
                      <td key={`td-${ci}`} className="px-3 py-2 text-foreground/90 align-top">
                        {renderInlineText(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        continue;
      }
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^\d+\.\s+/, ""));
        index += 1;
      }
      blocks.push(
        <ol key={`ol-${index}`} className="list-decimal space-y-1 pl-5">
          {items.map((item, itemIndex) => (
            <li key={`ol-item-${itemIndex}`}>{renderInlineText(item)}</li>
          ))}
        </ol>
      );
      continue;
    }

    if (/^[*\-•]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length && /^[*\-•]\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^[*\-•]\s+/, ""));
        index += 1;
      }
      blocks.push(
        <ul key={`ul-${index}`} className="list-disc space-y-1 pl-5">
          {items.map((item, itemIndex) => (
            <li key={`ul-item-${itemIndex}`}>{renderInlineText(item)}</li>
          ))}
        </ul>
      );
      continue;
    }

    blocks.push(
      <p key={`p-${index}`} className="leading-relaxed">
        {renderInlineText(line)}
      </p>
    );
    index += 1;
  }

  return <div className="space-y-2 text-sm">{blocks}</div>;
}

export default function AssistantPage() {
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [activeChatId, setActiveChatId] = useState<string>("");
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [patientsList, setPatientsList] = useState<Array<{
    patient_id: string;
    name: string;
    diagnosis?: string[];
    status?: string;
  }>>(patients);
  const [patientSearch, setPatientSearch] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let isMounted = true;
    async function loadPatients() {
      try {
        const data = await fetchApi<Array<{
          patient_id: string;
          name: string;
          diagnosis?: string[];
          status?: string;
        }>>("/api/patients");
        if (isMounted && Array.isArray(data) && data.length > 0) {
          setPatientsList(data);
        }
      } catch {
        // Fallback to local mock data
      }
    }
    loadPatients();
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) {
      const session = createChatSession();
      setChatSessions([session]);
      setActiveChatId(session.id);
      return;
    }

    try {
      const parsed = JSON.parse(raw) as ChatSession[];
      if (parsed.length === 0) {
        const session = createChatSession();
        setChatSessions([session]);
        setActiveChatId(session.id);
        return;
      }
      setChatSessions(parsed);
      setActiveChatId(parsed[0].id);
    } catch {
      const session = createChatSession();
      setChatSessions([session]);
      setActiveChatId(session.id);
    }
  }, []);

  useEffect(() => {
    if (chatSessions.length === 0) {
      localStorage.removeItem(CHAT_STORAGE_KEY);
      return;
    }
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(chatSessions));
  }, [chatSessions]);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chatSessions, activeChatId, isTyping]);

  const activeChat = useMemo(
    () => chatSessions.find((chat) => chat.id === activeChatId) ?? chatSessions[0],
    [chatSessions, activeChatId]
  );

  const selectedPatient = activeChat?.selectedPatientId ?? "";
  const messages = activeChat?.messages ?? [];

  const updateActiveChat = (updater: (chat: ChatSession) => ChatSession) => {
    setChatSessions((prev) =>
      prev.map((chat) => {
        if (chat.id !== activeChatId) return chat;
        const updated = updater(chat);
        return { ...updated, updatedAt: new Date().toISOString() };
      })
    );
  };

  const createNewChat = () => {
    const session = createChatSession();
    setChatSessions((prev) => [session, ...prev]);
    setActiveChatId(session.id);
    setInput("");
  };

  const deleteChat = (chatId: string) => {
    setChatSessions((prev) => {
      const target = prev.find((chat) => chat.id === chatId);
      if (!target) return prev;
      if (!window.confirm(`Delete chat "${target.title}"?`)) return prev;

      if (prev.length === 1) {
        const fresh = createChatSession();
        setActiveChatId(fresh.id);
        setInput("");
        return [fresh];
      }

      const filtered = prev.filter((chat) => chat.id !== chatId);
      if (activeChatId === chatId) {
        setActiveChatId(filtered[0].id);
        setInput("");
      }
      return filtered;
    });
  };

  const handleSend = async () => {
    if (!input.trim() || !activeChat) return;

    const prompt = input.trim();
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: prompt,
      timestamp: new Date().toISOString(),
    };

    updateActiveChat((chat) => ({
      ...chat,
      title: chat.messages.length === 0 ? prompt.slice(0, 50) : chat.title,
      messages: [...chat.messages, userMessage],
    }));

    setInput("");
    setIsTyping(true);

    const isAllPatientsMode = !selectedPatient;
    const targetPatientId = isAllPatientsMode ? undefined : selectedPatient;

    try {
      const response = await agentQuery(prompt, targetPatientId, { allPatients: isAllPatientsMode });
      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: response,
        timestamp: new Date().toISOString(),
      };
      updateActiveChat((chat) => ({
        ...chat,
        messages: [...chat.messages, assistantMessage],
      }));
    } catch {
      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "Backend unavailable. Please ensure backend1 is running on http://localhost:4000.",
        timestamp: new Date().toISOString(),
      };
      updateActiveChat((chat) => ({
        ...chat,
        messages: [...chat.messages, assistantMessage],
      }));
    } finally {
      setIsTyping(false);
    }
  };

  const handlePatientSelect = (patientId: string) => {
    if (!activeChat) return;

    updateActiveChat((chat) => ({
      ...chat,
      selectedPatientId: patientId,
    }));

    if (patientId) {
      const patient = patientsList.find((p) => p.patient_id === patientId);
      if (patient) {
        setInput(`Generate a detailed consultation brief for ${patient.name}`);
      }
    }
  };

  const selectValue = selectedPatient === "" ? ALL_PATIENTS_VALUE : selectedPatient;

  const handleSelectChange = (value: string) => {
    if (value === ALL_PATIENTS_VALUE) {
      handlePatientSelect("");
    } else {
      handlePatientSelect(value);
    }
  };

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">AI Doctor Assistant</h1>
          <p className="text-muted-foreground">Your intelligent clinical companion powered by AI</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {aiCapabilities.map((cap) => (
            <div key={cap.title} className={cn("flex items-center gap-2 rounded-xl px-3 py-2", cap.color)}>
              <cap.icon className="h-4 w-4" />
              <span className="text-xs font-medium">{cap.title}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-6 lg:grid-cols-[minmax(360px,420px)_minmax(0,1fr)]">
        <div className="hidden flex-col gap-4 lg:sticky lg:top-4 lg:flex lg:max-h-[calc(100vh-10rem)]">
          <Card className="rounded-2xl border-0 shadow-sm">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold">Chat History</CardTitle>
                <Button size="sm" onClick={createNewChat} className="h-8 rounded-lg px-2">
                  <Plus className="mr-1 h-4 w-4" />
                  New
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-2">
              <ScrollArea className="max-h-56 pr-2">
                <div className="space-y-2">
                  {chatSessions.map((chat) => (
                    <div
                      key={chat.id}
                      className={cn(
                        "group flex items-center gap-2 rounded-xl p-2 transition-all",
                        activeChatId === chat.id ? "bg-primary text-primary-foreground" : "bg-muted/50 hover:bg-muted"
                      )}
                    >
                      <button
                        onClick={() => setActiveChatId(chat.id)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <MessageSquare className="h-4 w-4 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{chat.title}</p>
                          <p className={cn("text-xs", activeChatId === chat.id ? "opacity-80" : "text-muted-foreground")}>
                            {new Date(chat.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                          </p>
                        </div>
                      </button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className={cn(
                          "h-7 w-7 rounded-lg",
                          activeChatId === chat.id
                            ? "text-primary-foreground/70 hover:bg-white/20 hover:text-primary-foreground"
                            : "text-muted-foreground hover:text-foreground"
                        )}
                        onClick={() => deleteChat(chat.id)}
                        aria-label={`Delete ${chat.title}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          <Card className="rounded-2xl border-0 shadow-sm">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold">Select Patient</CardTitle>
                <span className="text-xs text-muted-foreground">{patientsList.length} total</span>
              </div>
              <div className="relative mt-2">
                <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search patient..."
                  value={patientSearch}
                  onChange={(e) => setPatientSearch(e.target.value)}
                  className="h-8 rounded-lg pl-8 text-xs bg-muted/40 border-border/50"
                />
              </div>
            </CardHeader>
            <CardContent className="p-2">
              <ScrollArea className="max-h-60 pr-2">
                <div className="space-y-1">
                  <button
                    onClick={() => handlePatientSelect("")}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-xl p-2.5 text-left text-xs transition-all",
                      selectedPatient === ""
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "bg-muted/40 hover:bg-muted"
                    )}
                  >
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-background/20 font-semibold">
                      ALL
                    </div>
                    <div className="flex-1 overflow-hidden">
                      <p className="font-semibold">All Patients (Clinic Mode)</p>
                      <p className={cn("text-[11px]", selectedPatient === "" ? "opacity-80" : "text-muted-foreground")}>
                        Clinic-wide screening & stats
                      </p>
                    </div>
                  </button>

                  {patientsList
                    .filter((p) => {
                      if (!patientSearch.trim()) return true;
                      const q = patientSearch.toLowerCase();
                      return (
                        p.name.toLowerCase().includes(q) ||
                        p.patient_id.toLowerCase().includes(q) ||
                        (p.diagnosis || []).some((d) => d.toLowerCase().includes(q))
                      );
                    })
                    .slice(0, 20)
                    .map((patient) => (
                      <button
                        key={patient.patient_id}
                        onClick={() => handlePatientSelect(patient.patient_id)}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-xl p-2.5 text-left transition-all",
                          selectedPatient === patient.patient_id
                            ? "bg-primary text-primary-foreground shadow-sm"
                            : "bg-muted/30 hover:bg-muted"
                        )}
                      >
                        <Avatar className="h-7 w-7 shrink-0">
                          <AvatarImage src={`https://i.pravatar.cc/100?u=${patient.patient_id}`} />
                          <AvatarFallback
                            className={cn(
                              "text-[10px] font-semibold",
                              selectedPatient === patient.patient_id ? "bg-white/20" : "bg-primary/10 text-primary"
                            )}
                          >
                            {patient.name.split(" ").map((n) => n[0]).join("")}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-1 overflow-hidden">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] font-mono opacity-70">{patient.patient_id}</span>
                            <p className="truncate text-xs font-medium">{patient.name}</p>
                          </div>
                          <p
                            className={cn(
                              "truncate text-[11px]",
                              selectedPatient === patient.patient_id ? "opacity-80" : "text-muted-foreground"
                            )}
                          >
                            {patient.diagnosis?.[0] || "General consultation"}
                          </p>
                        </div>
                        {patient.status === "critical" && (
                          <div className="h-2 w-2 shrink-0 rounded-full bg-destructive" title="Critical Status" />
                        )}
                      </button>
                    ))}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          <Card className="flex-1 rounded-2xl border-0 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">Quick Prompts</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2">
              {quickPrompts.map((prompt) => (
                <button
                  key={prompt.label}
                  onClick={() => setInput(prompt.query)}
                  className="w-full rounded-xl border border-border/60 bg-muted/40 px-4 py-3 text-left text-sm text-muted-foreground transition-colors hover:bg-primary hover:text-primary-foreground"
                >
                  {prompt.label}
                </button>
              ))}
            </CardContent>
          </Card>
        </div>

        <Card className="flex min-h-0 flex-col overflow-hidden rounded-2xl border-0 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-4 sm:px-6">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary shadow-md">
                <Bot className="h-6 w-6 text-white" />
              </div>
              <div>
                <h3 className="font-semibold text-foreground">MedAI Assistant</h3>
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 animate-pulse rounded-full bg-foreground" />
                  <span className="text-xs text-muted-foreground">Online - Ready to help</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button onClick={createNewChat} variant="outline" size="sm" className="rounded-xl lg:hidden">
                <Plus className="mr-1 h-4 w-4" />
                New Chat
              </Button>
              <Select value={selectValue} onValueChange={handleSelectChange}>
                <SelectTrigger className="w-52 rounded-xl border-border bg-background sm:w-56">
                  <SelectValue placeholder="Context: All Patients" />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value={ALL_PATIENTS_VALUE}>
                    <span className="font-semibold">All Patients (Clinic Overview)</span>
                  </SelectItem>
                  {patientsList.map((p) => (
                    <SelectItem key={p.patient_id} value={p.patient_id}>
                      <span className="font-mono text-xs text-muted-foreground mr-1.5">{p.patient_id}</span>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="ghost" size="icon" className="rounded-xl">
                <MoreHorizontal className="h-5 w-5" />
              </Button>
            </div>
          </div>

          <div className="border-b border-border px-4 py-2 lg:hidden">
            <ScrollArea className="w-full">
              <div className="flex gap-2 pb-1">
                {chatSessions.map((chat) => (
                  <div
                    key={`mobile-${chat.id}`}
                    className={cn(
                      "flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-1 text-xs",
                      activeChatId === chat.id
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-muted-foreground"
                    )}
                  >
                    <button onClick={() => setActiveChatId(chat.id)} className="max-w-40 truncate px-1 text-left">
                      {chat.title}
                    </button>
                    <button
                      onClick={() => deleteChat(chat.id)}
                      className={cn("rounded-full p-1", activeChatId === chat.id ? "hover:bg-white/20" : "hover:bg-muted")}
                      aria-label={`Delete ${chat.title}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto bg-gradient-to-b from-muted/20 to-transparent p-6">
            {messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center py-12 text-center">
                <div className="mb-6 flex h-24 w-24 items-center justify-center rounded-3xl bg-primary shadow-xl">
                  <Sparkles className="h-12 w-12 text-white" />
                </div>
                <h3 className="text-xl font-bold text-foreground">Hello, Doctor</h3>
                <p className="mt-2 max-w-md text-muted-foreground">
                  Ask about patients, medications, lab trends, drug interactions, or consultation summaries.
                </p>
                <div className="mt-8 flex flex-wrap justify-center gap-2">
                  {quickPrompts.map((prompt) => (
                    <Button key={prompt.label} variant="outline" className="rounded-full" onClick={() => setInput(prompt.query)}>
                      {prompt.label}
                    </Button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                {messages.map((message) => (
                  <div key={message.id} className={cn("flex gap-4", message.role === "user" && "flex-row-reverse")}>
                    <Avatar className="h-10 w-10 shrink-0 shadow-sm">
                      {message.role === "assistant" ? (
                        <AvatarFallback className="bg-primary text-white">
                          <Bot className="h-5 w-5" />
                        </AvatarFallback>
                      ) : (
                        <>
                          <AvatarImage src="https://images.unsplash.com/photo-1612349317150-e413f6a5b16d?w=100&h=100&fit=crop&crop=face" />
                          <AvatarFallback className="bg-primary/10 text-primary">
                            <User className="h-5 w-5" />
                          </AvatarFallback>
                        </>
                      )}
                    </Avatar>
                    <div
                      className={cn(
                        "max-w-[85%] rounded-2xl px-4 py-4 shadow-sm sm:max-w-[75%] sm:px-5",
                        message.role === "assistant" ? "border border-border bg-card" : "bg-primary text-primary-foreground"
                      )}
                    >
                      <FormattedMessage content={message.content} />
                      <p className={cn("mt-2 text-xs", message.role === "assistant" ? "text-muted-foreground" : "opacity-70")}>
                        {new Date(message.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                      </p>
                    </div>
                  </div>
                ))}
                {isTyping && (
                  <div className="flex gap-4">
                    <Avatar className="h-10 w-10 shrink-0 shadow-sm">
                      <AvatarFallback className="bg-primary text-white">
                        <Bot className="h-5 w-5" />
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex items-center gap-1.5 rounded-2xl border border-border bg-card px-5 py-4 shadow-sm">
                      <div className="h-2 w-2 animate-bounce rounded-full bg-foreground" />
                      <div className="h-2 w-2 animate-bounce rounded-full bg-foreground [animation-delay:0.15s]" />
                      <div className="h-2 w-2 animate-bounce rounded-full bg-foreground [animation-delay:0.3s]" />
                    </div>
                  </div>
                )}
                <div ref={bottomRef} />
              </div>
            )}
          </div>

          <div className="border-t border-border bg-muted/30 p-4">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleSend();
              }}
              className="flex items-center gap-3"
            >
              <Button type="button" variant="ghost" size="icon" className="shrink-0 rounded-xl text-muted-foreground hover:text-foreground">
                <Paperclip className="h-5 w-5" />
              </Button>
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask about patients, medications, lab results..."
                className="flex-1 rounded-xl border-border bg-background py-6 text-sm"
              />
              <Button type="button" variant="ghost" size="icon" className="shrink-0 rounded-xl text-muted-foreground hover:text-foreground">
                <Mic className="h-5 w-5" />
              </Button>
              <Button type="submit" disabled={!input.trim() || isTyping} className="shrink-0 rounded-xl px-6 shadow-md">
                <Send className="mr-2 h-4 w-4" />
                Send
              </Button>
            </form>
          </div>
        </Card>
      </div>
    </div>
  );
}
