cmake_minimum_required(VERSION 3.16)
project(physix_convert LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(MSVC)
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

set(PHYSX_ROOT "${CMAKE_SOURCE_DIR}/../third_party/PhysX-3.4/PhysX_3.4")
set(PHYSX_INCLUDE "${PHYSX_ROOT}/Include")
set(PHYSX_LIB_DIR "${PHYSX_ROOT}/Lib/vc15win64")
set(PHYSX_SHARED_LIB_DIR "${CMAKE_SOURCE_DIR}/../third_party/PhysX-3.4/PxShared/lib/vc15win64")
set(PHYSX_SHARED_INCLUDE "${CMAKE_SOURCE_DIR}/../third_party/PhysX-3.4/PxShared/include")

if(NOT EXISTS "${PHYSX_INCLUDE}/PxPhysicsAPI.h")
    message(FATAL_ERROR "PhysX headers not found at ${PHYSX_INCLUDE}. Build PhysX SDK first.")
endif()

add_executable(physix_convert
    src/main.cpp
    src/physx_app.cpp
    src/mesh_extract.cpp
    src/gltf_export.cpp
)

target_include_directories(physix_convert PRIVATE src "${PHYSX_INCLUDE}" "${PHYSX_SHARED_INCLUDE}")

set(PHYSX_LIBS
    PhysX3ExtensionsPROFILE
    PhysX3PROFILE_x64
    PhysX3CommonPROFILE_x64
    PhysX3CookingPROFILE_x64
    PsFastXmlPROFILE_x64
    PxPvdSDKPROFILE_x64
    PxFoundationPROFILE_x64
    PxTaskPROFILE_x64
    LowLevelPROFILE
    LowLevelAABBPROFILE
    LowLevelDynamicsPROFILE
    SceneQueryPROFILE
    SimulationControllerPROFILE
)

target_link_directories(physix_convert PRIVATE "${PHYSX_LIB_DIR}" "${PHYSX_SHARED_LIB_DIR}")
target_link_libraries(physix_convert PRIVATE ${PHYSX_LIBS})

if(WIN32)
    set(PHYSX_SHARED_BIN_DIR "${CMAKE_SOURCE_DIR}/../third_party/PhysX-3.4/PxShared/bin/vc15win64")
    foreach(dll PhysX3PROFILE_x64 PhysX3CommonPROFILE_x64 PhysX3CookingPROFILE_x64 PhysXDevice64 PxFoundationPROFILE_x64 PxPvdSDKPROFILE_x64)
        foreach(bin_dir "${PHYSX_BIN_DIR}" "${PHYSX_SHARED_BIN_DIR}")
            if(EXISTS "${bin_dir}/${dll}.dll")
                add_custom_command(TARGET physix_convert POST_BUILD
                    COMMAND ${CMAKE_COMMAND} -E copy_if_different
                        "${bin_dir}/${dll}.dll"
                        "$<TARGET_FILE_DIR:physix_convert>"
                )
                break()
            endif()
        endforeach()
    endforeach()
endif()
