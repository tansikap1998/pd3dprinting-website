FROM node:18-bullseye-slim

# Install system dependencies needed for compiling CuraEngine
RUN apt-get update && apt-get install -y \
    cmake \
    git \
    build-essential \
    libprotobuf-dev \
    protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

# Clone and build CuraEngine
# Note: Using a specific stable tag is recommended for production
RUN git clone https://github.com/Ultimaker/CuraEngine.git /CuraEngine
WORKDIR /CuraEngine
RUN mkdir build && cd build && cmake .. && make -j$(nproc)
# Symlink or move binary to path
RUN ln -s /CuraEngine/build/CuraEngine /usr/local/bin/CuraEngine

# Setup Node.js app
WORKDIR /app
COPY package*.json ./
RUN npm install

# Copy application code
COPY . .

# Run the typescript build
# RUN npm run build

# Start the worker
CMD ["node", "src/index.js"]
