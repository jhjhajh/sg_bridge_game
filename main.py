import logging
import os
from contextlib import asynccontextmanager
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from telegram import Update
from telegram.ext import Application, CallbackQueryHandler, CommandHandler, MessageHandler, filters
from handlers import start, stop, bid, card, inline_button

load_dotenv()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

TOKEN = os.getenv("TELEGRAM_TOKEN")
WEBHOOK_URL = os.getenv("WEBHOOK_URL")

application = Application.builder().token(TOKEN).build()

@asynccontextmanager
async def lifespan(app: FastAPI):
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("stop", stop))
    application.add_handler(CallbackQueryHandler(inline_button))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, bid))
    await application.initialize()
    await application.start()
    if WEBHOOK_URL:
        await application.bot.set_webhook(WEBHOOK_URL)
        logger.info(f"✅ Webhook set: {WEBHOOK_URL}")
    else:
        logger.warning("⚠️ WEBHOOK_URL not set. Skipping webhook setup. Please set the environment variable after deployment and restart the container.")
    
    yield
    
    if WEBHOOK_URL:
        # Avoid exception if webhook wasn't set or is invalid
        try:
            await application.bot.delete_webhook()
        except Exception as e:
            logger.warning(f"Error deleting webhook: {e}")
    try:
        await application.stop()
        await application.shutdown() 
    except RuntimeError:
        pass

app = FastAPI(lifespan=lifespan)

@app.post("/webhook")
async def webhook(request: Request):
    data = await request.json()
    update = Update.de_json(data, application.bot)
    if update:
        await application.process_update(update)
    return {"status": "ok"}

@app.get("/health")
async def health():
    return {"status": "healthy"}
