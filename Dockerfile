FROM python:3.11-slim

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Set the working directory in the container
WORKDIR /app

# Copy the requirements file into the container
COPY requirements.txt .

# Install dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application code into the container
COPY . .

# Expose the port the app runs on (informational)
EXPOSE 8000

# Command to run the application using uvicorn (Railway provides $PORT)
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}
