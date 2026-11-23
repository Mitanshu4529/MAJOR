from contextlib import asynccontextmanager
from pathlib import Path
import traceback

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field

from llm_chain import chain_labels
from backend import (
    close_resources,
    get_travel_state,
    resume_travel_agent,
    run_travel_agent,
)

BASE_DIR = Path(__file__).resolve().parent


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    close_resources()


app = FastAPI(
    title="TripMate AI",
    description=(
        "LangGraph Multi-Agent Travel Planner with Supervisor, Guardrails, "
        "Human-in-the-Loop, and FastAPI Frontend"
    ),
    version="2.1.0",
    lifespan=lifespan,
)

app.mount(
    "/static",
    StaticFiles(directory=str(BASE_DIR / "static")),
    name="static",
)

templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))


class TravelRequest(BaseModel):
    message: str


class ApprovalRequest(BaseModel):
    thread_id: str = Field(min_length=1)
    approved: bool
    feedback: str = ""


def _error(status_code: int, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"success": False, "error": message},
    )


@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={},
    )


# The agent endpoints are plain `def` (not `async def`) on purpose: FastAPI
# runs them in a worker thread, so a long multi-agent run doesn't block the
# event loop and the server keeps answering other requests. It also lets the
# agents call asyncio.run() for MCP tools without the nest_asyncio workaround.
@app.post("/api/travel")
def travel_planner(request_data: TravelRequest):
    user_message = request_data.message.strip()

    if not user_message:
        return _error(400, "Message cannot be empty.")

    try:
        result = run_travel_agent(user_input=user_message)
        return JSONResponse(content={"success": True, **result})

    except Exception as exc:
        print("ERROR:", exc)
        traceback.print_exc()
        return _error(500, str(exc))


@app.post("/api/travel/approve")
def approve_travel_plan(request_data: ApprovalRequest):
    if not request_data.approved and not request_data.feedback.strip():
        return _error(
            400, "Please provide revision feedback when rejecting the draft."
        )

    try:
        result = resume_travel_agent(
            thread_id=request_data.thread_id,
            approved=request_data.approved,
            feedback=request_data.feedback,
        )
        return JSONResponse(content={"success": True, **result})

    except ValueError as exc:
        return _error(409, str(exc))

    except Exception as exc:
        print("APPROVAL ERROR:", exc)
        traceback.print_exc()
        return _error(500, str(exc))


@app.get("/api/travel/{thread_id}")
def travel_state(thread_id: str):
    try:
        result = get_travel_state(thread_id)
        return JSONResponse(content={"success": True, **result})

    except LookupError as exc:
        return _error(404, str(exc))

    except Exception as exc:
        print("STATE ERROR:", exc)
        traceback.print_exc()
        return _error(500, str(exc))


@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "message": "TripMate AI API is running",
        "features": [
            "supervisor_agent",
            "input_guardrail",
            "human_in_the_loop",
            "llm_fallback_chain",
        ],
        # Order the models are tried in (best first, local Ollama last).
        "llm_chain": chain_labels(),
    }


@app.get("/favicon.ico")
async def favicon():
    return JSONResponse(content={})


if __name__ == "__main__":
    uvicorn.run(
        "app:app",
        host="127.0.0.1",
        port=8000,
        reload=True,
    )
