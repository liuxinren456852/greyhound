#pragma once

#include <vector>
#include <map>

#include <sqlite3.h>

#include "grey-common.hpp"

class GreyWriter
{
public:
    GreyWriter(const pdal::QuadIndex& quadIndex, GreyMeta meta);

    void write(std::string filename) const;

private:
    const GreyMeta m_meta;
    const pdal::QuadIndex& m_quadIndex;

    void writeMeta(sqlite3* db) const;
    void writeData(
            sqlite3* db,
            const std::map<uint64_t, std::vector<std::size_t>>& clusters) const;

    void build(
            std::map<uint64_t, std::vector<std::size_t>>& results,
            const BBox& bbox,
            std::size_t level,
            uint64_t id) const;

    std::vector<std::size_t> getPoints(
            const BBox& bbox,
            std::size_t level) const;
};

